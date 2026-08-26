import { defaultProviders, providerConfig, SarvamProvider } from '@/lib/providers';
import type { AudioChunkHandler, SpeakInput, SpeakResult } from '@/lib/providers/types';
import { playSpeechBlob, prepareSpeechStream, speakWithBrowser } from './speakAnswer';
import type { PreparedSpeechStream, StartSpeechStream, StopSpeech } from './speakAnswer';

type Speak = (input: SpeakInput) => Promise<SpeakResult>;
type SpeakStream = (
  input: SpeakInput,
  onAudioChunk: AudioChunkHandler,
  signal?: AbortSignal,
) => Promise<void>;
type PlayBlob = (audio: Blob, onEnded: () => void) => Promise<StopSpeech>;
type SpeakBrowser = (text: string, language: string, onEnded: () => void) => StopSpeech;
type PrepareStream = (startStream: StartSpeechStream) => PreparedSpeechStream;

export const TTS_FALLBACK_RETRIES = 2;

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

interface BlobSource {
  readonly kind: 'blob';
  readonly audio: Blob;
  readonly fallbackText?: string;
  readonly fallbackLanguage?: string;
  readonly batchAttempt?: number;
}

interface BrowserSource {
  readonly kind: 'browser';
  readonly text: string;
  readonly language: string;
  readonly sarvamUnavailable?: boolean;
}

interface StreamSource {
  readonly kind: 'stream';
  readonly prepared: PreparedSpeechStream;
  readonly text: string;
  readonly language: string;
}

type SpeechSource = BlobSource | BrowserSource | StreamSource;

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let settled = false;
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

export interface SpeechQueueTicket {
  /** Resolves when the provider audio (or browser fallback) is ready to be queued. */
  readonly ready: Promise<void>;
  /** Resolves when playback finishes or the queue is stopped. */
  readonly done: Promise<void>;
}

export interface SpeechQueue {
  enqueue(audio: Blob, onDone?: () => void): SpeechQueueTicket;
  enqueueBrowserSpeech(text: string, language: string): SpeechQueueTicket;
  enqueueSpeech(
    text: string,
    language: string,
    timingLabel?: string,
    onReady?: () => void,
  ): SpeechQueueTicket;
  /** End only the active clip and continue with the remaining queue. */
  skipCurrent(): void;
  stop(): void;
}

export interface SpeechQueueOptions {
  readonly speak?: Speak;
  readonly speakStream?: SpeakStream;
  readonly playBlob?: PlayBlob;
  readonly prepareStream?: PrepareStream;
  readonly speakBrowser?: SpeakBrowser;
  readonly now?: () => number;
  readonly logTiming?: (message: string) => void;
  readonly onError?: (error: unknown) => void;
}

interface QueueItem {
  readonly source: SpeechSource;
  readonly done: Deferred;
  readonly onDone?: () => void;
  completed: boolean;
}

interface PendingSpeech {
  readonly generation: number;
  readonly ready: Deferred;
  readonly done: Deferred;
  prepared?: PreparedSpeechStream;
  source?: SpeechSource;
}

/** One stoppable playback lane. TTS requests start together but enter the lane in call order. */
export function createSpeechQueue(options: SpeechQueueOptions = {}): SpeechQueue {
  const speak = options.speak ?? ((input) => defaultProviders().speak(input));
  const streamingProvider = options.speak === undefined && options.speakStream === undefined
    ? new SarvamProvider(providerConfig)
    : null;
  const speakStream = options.speakStream ?? (
    streamingProvider
      ? (input: SpeakInput, onAudioChunk: AudioChunkHandler, signal?: AbortSignal) => (
        streamingProvider.speakStream(input, onAudioChunk, signal)
      )
      : undefined
  );
  const playBlob = options.playBlob ?? playSpeechBlob;
  const prepareStream = options.prepareStream ?? prepareSpeechStream;
  const speakBrowser = options.speakBrowser ?? speakWithBrowser;
  const now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
  const logTiming = options.logTiming ?? ((message) => console.info(message));
  const onError = options.onError ?? (() => undefined);

  let generation = 0;
  let running = false;
  let currentStop: StopSpeech | null = null;
  let skipCurrentRequested = false;
  let nextSpeechSequence = 0;
  let nextSpeechToQueue = 0;
  let queue: QueueItem[] = [];
  // Once streaming TTS fails (e.g. its WebSocket is refused under conversation-mode
  // socket pressure), stop reopening a doomed socket per clip — use batch for the session.
  let streamingUnavailable = false;
  const pendingSpeech = new Map<number, PendingSpeech>();

  const startBrowserFallback = (
    text: string,
    language: string,
    onEnded: () => void,
  ): StopSpeech => {
    logTiming('[voice] clip via BROWSER speech (Sarvam unavailable)');
    return speakBrowser(text, language, onEnded);
  };

  const startBatchFallback = async (
    text: string,
    language: string,
    onEnded: () => void,
  ): Promise<StopSpeech> => {
    for (let attempt = 1; attempt <= TTS_FALLBACK_RETRIES; attempt += 1) {
      let result: SpeakResult;
      try {
        result = await speak({ text, language });
      } catch {
        continue;
      }

      logTiming(`[voice] clip via batch Sarvam (attempt ${attempt})`);
      try {
        return await playBlob(result.audio, onEnded);
      } catch {
        break;
      }
    }

    return startBrowserFallback(text, language, onEnded);
  };

  const startStreamSource = async (
    source: StreamSource,
    onEnded: () => void,
  ): Promise<StopSpeech> => {
    let stopped = false;
    let finished = false;
    let fallingBack = false;
    let activeStop: StopSpeech = () => source.prepared.stop();
    const finish = () => {
      if (finished || stopped) return;
      finished = true;
      onEnded();
    };
    const fallBack = async (streamError: unknown) => {
      if (stopped || finished || fallingBack) return;
      if (isAbortError(streamError)) {
        source.prepared.stop();
        finish();
        return;
      }
      fallingBack = true;
      activeStop();
      source.prepared.stop();
      try {
        const stop = await startBatchFallback(source.text, source.language, finish);
        if (stopped || finished) {
          stop();
          return;
        }
        activeStop = stop;
      } catch (error) {
        onError(error ?? streamError);
        finish();
      }
    };

    try {
      activeStop = await source.prepared.play(finish, (error) => {
        void fallBack(error);
      });
      logTiming('[voice] clip via streaming Sarvam');
    } catch (error) {
      await fallBack(error);
    }

    return () => {
      if (stopped || finished) return;
      stopped = true;
      activeStop();
      source.prepared.stop();
    };
  };

  const startSource = async (
    source: SpeechSource,
    onEnded: () => void,
  ): Promise<StopSpeech> => {
    if (source.kind === 'browser') {
      if (source.sarvamUnavailable) {
        logTiming('[voice] clip via BROWSER speech (Sarvam unavailable)');
      }
      return speakBrowser(source.text, source.language, onEnded);
    }
    if (source.kind === 'stream') {
      return startStreamSource(source, onEnded);
    }
    try {
      if (source.batchAttempt !== undefined) {
        logTiming(`[voice] clip via batch Sarvam (attempt ${source.batchAttempt})`);
      }
      return await playBlob(source.audio, onEnded);
    } catch (error) {
      if (source.fallbackText && source.fallbackLanguage) {
        return startBrowserFallback(source.fallbackText, source.fallbackLanguage, onEnded);
      }
      throw error;
    }
  };

  const playItem = async (item: QueueItem, run: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      let finished = false;
      let registeredStop: StopSpeech | null = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (currentStop === registeredStop) currentStop = null;
        resolve();
      };

      void startSource(item.source, finish).then((stop) => {
        if (finished || run !== generation || skipCurrentRequested) {
          stop();
          finish();
          return;
        }
        registeredStop = () => {
          stop();
          finish();
        };
        currentStop = registeredStop;
      }).catch((error) => {
        onError(error);
        finish();
      });
    });
  };

  const pump = async () => {
    if (running) return;
    running = true;
    const run = generation;
    try {
      while (run === generation && queue.length > 0) {
        const item = queue[0];
        if (!item) break;
        skipCurrentRequested = false;
        await playItem(item, run);
        if (run !== generation) return;
        if (queue[0] === item) queue.shift();
        if (!item.completed) {
          item.completed = true;
          item.onDone?.();
          item.done.resolve();
        }
      }
    } finally {
      if (run === generation) {
        running = false;
        if (queue.length > 0) void pump();
      }
    }
  };

  const appendSource = (
    source: SpeechSource,
    ready: Deferred = deferred(),
    done: Deferred = deferred(),
    onDone?: () => void,
  ): SpeechQueueTicket => {
    ready.resolve();
    queue.push({ source, done, onDone, completed: false });
    void pump();
    return { ready: ready.promise, done: done.promise };
  };

  const flushPreparedSpeech = () => {
    while (true) {
      const pending = pendingSpeech.get(nextSpeechToQueue);
      if (!pending?.source) return;
      pendingSpeech.delete(nextSpeechToQueue);
      nextSpeechToQueue += 1;
      if (pending.generation !== generation) {
        pending.done.resolve();
        continue;
      }
      queue.push({ source: pending.source, done: pending.done, completed: false });
    }
    // Unreachable; kept as a loop so every consecutively-ready sentence is appended together.
  };

  const api: SpeechQueue = {
    enqueue(audio, onDone) {
      return appendSource({ kind: 'blob', audio }, deferred(), deferred(), onDone);
    },

    enqueueBrowserSpeech(text, language) {
      return appendSource({ kind: 'browser', text, language });
    },

    enqueueSpeech(text, language, timingLabel = 'TTS', onReady) {
      const run = generation;
      const sequence = nextSpeechSequence;
      nextSpeechSequence += 1;
      const ready = deferred();
      const done = deferred();
      const pending: PendingSpeech = { generation: run, ready, done };
      pendingSpeech.set(sequence, pending);
      const startedAt = now();

      const acceptSource = (source: SpeechSource) => {
        if (run !== generation) {
          if (source.kind === 'stream') source.prepared.stop();
          return;
        }
        pending.source = source;
        onReady?.();
        ready.resolve();
        flushPreparedSpeech();
        void pump();
      };
      const prepareBatchFallback = () => {
        void (async () => {
          for (let attempt = 1; attempt <= TTS_FALLBACK_RETRIES; attempt += 1) {
            try {
              const result = await speak({ text, language });
              logTiming(
                `[voice timing] ${timingLabel}: batch fallback ready in ${Math.round(now() - startedAt)} ms`,
              );
              acceptSource({
                kind: 'blob',
                audio: result.audio,
                fallbackText: text,
                fallbackLanguage: language,
                batchAttempt: attempt,
              });
              return;
            } catch {
              // Retry synthesis before conceding to browser speech.
            }
          }
          logTiming(
            `[voice timing] ${timingLabel}: providers unavailable after ${Math.round(now() - startedAt)} ms; using browser speech`,
          );
          acceptSource({ kind: 'browser', text, language, sarvamUnavailable: true });
        })();
      };

      if (!speakStream || streamingUnavailable) {
        prepareBatchFallback();
        return { ready: ready.promise, done: done.promise };
      }

      try {
        const prepared = prepareStream((onAudioChunk, signal) => (
          speakStream({ text, language }, onAudioChunk, signal)
        ));
        pending.prepared = prepared;
        void prepared.ready.then(() => {
          logTiming(
            `[voice timing] ${timingLabel}: first streaming audio in ${Math.round(now() - startedAt)} ms`,
          );
          acceptSource({ kind: 'stream', prepared, text, language });
        }).catch(() => {
          if (!streamingUnavailable) {
            streamingUnavailable = true;
            logTiming('[voice] streaming TTS unavailable — using batch Sarvam for the rest of this session');
          }
          if (run !== generation) return;
          pending.prepared = undefined;
          prepared.stop();
          prepareBatchFallback();
        });
      } catch {
        prepareBatchFallback();
      }

      return { ready: ready.promise, done: done.promise };
    },

    skipCurrent() {
      if (!running || queue.length === 0) return;
      skipCurrentRequested = true;
      currentStop?.();
    },

    stop() {
      generation += 1;
      const stop = currentStop;
      currentStop = null;
      stop?.();
      for (const item of queue) {
        if (item.completed) continue;
        if (item.source.kind === 'stream') item.source.prepared.stop();
        item.completed = true;
        item.onDone?.();
        item.done.resolve();
      }
      queue = [];
      for (const pending of pendingSpeech.values()) {
        pending.prepared?.stop();
        pending.ready.resolve();
        pending.done.resolve();
      }
      pendingSpeech.clear();
      nextSpeechSequence = 0;
      nextSpeechToQueue = 0;
      skipCurrentRequested = false;
      running = false;
    },
  };

  return api;
}
