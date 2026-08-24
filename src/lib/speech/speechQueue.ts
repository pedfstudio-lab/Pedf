import { defaultProviders } from '@/lib/providers';
import type { SpeakInput, SpeakResult } from '@/lib/providers/types';
import { playSpeechBlob, speakWithBrowser } from './speakAnswer';
import type { StopSpeech } from './speakAnswer';

type Speak = (input: SpeakInput) => Promise<SpeakResult>;
type PlayBlob = (audio: Blob, onEnded: () => void) => Promise<StopSpeech>;
type SpeakBrowser = (text: string, language: string, onEnded: () => void) => StopSpeech;

interface BlobSource {
  readonly kind: 'blob';
  readonly audio: Blob;
  readonly fallbackText?: string;
  readonly fallbackLanguage?: string;
}

interface BrowserSource {
  readonly kind: 'browser';
  readonly text: string;
  readonly language: string;
}

type SpeechSource = BlobSource | BrowserSource;

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
  readonly playBlob?: PlayBlob;
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
  source?: SpeechSource;
}

/** One stoppable playback lane. TTS requests start together but enter the lane in call order. */
export function createSpeechQueue(options: SpeechQueueOptions = {}): SpeechQueue {
  const speak = options.speak ?? ((input) => defaultProviders().speak(input));
  const playBlob = options.playBlob ?? playSpeechBlob;
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
  const pendingSpeech = new Map<number, PendingSpeech>();

  const startSource = async (
    source: SpeechSource,
    onEnded: () => void,
  ): Promise<StopSpeech> => {
    if (source.kind === 'browser') {
      return speakBrowser(source.text, source.language, onEnded);
    }
    try {
      return await playBlob(source.audio, onEnded);
    } catch (error) {
      if (source.fallbackText && source.fallbackLanguage) {
        return speakBrowser(source.fallbackText, source.fallbackLanguage, onEnded);
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

      void speak({ text, language }).then((result) => {
        logTiming(
          `[voice timing] ${timingLabel}: ${Math.round(now() - startedAt)} ms (${text.length} chars) :: ${JSON.stringify(text)}`,
        );
        if (run !== generation) return;
        pending.source = {
          kind: 'blob',
          audio: result.audio,
          fallbackText: text,
          fallbackLanguage: language,
        };
        onReady?.();
        ready.resolve();
        flushPreparedSpeech();
        void pump();
      }).catch(() => {
        logTiming(
          `[voice timing] ${timingLabel}: provider unavailable after ${Math.round(now() - startedAt)} ms; using browser speech`,
        );
        if (run !== generation) return;
        pending.source = { kind: 'browser', text, language };
        onReady?.();
        ready.resolve();
        flushPreparedSpeech();
        void pump();
      });

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
        item.completed = true;
        item.onDone?.();
        item.done.resolve();
      }
      queue = [];
      for (const pending of pendingSpeech.values()) {
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
