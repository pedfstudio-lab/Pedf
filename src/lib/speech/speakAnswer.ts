import { defaultProviders } from '@/lib/providers';

export type StopSpeech = () => void;
export type StartSpeechStream = (
  onAudioChunk: (audio: Uint8Array<ArrayBuffer>) => void,
  signal: AbortSignal,
) => Promise<void>;

export interface PreparedSpeechStream {
  /** Resolves after the first MP3 bytes have been appended to the live buffer. */
  readonly ready: Promise<void>;
  play(onEnded: () => void, onError: (error: unknown) => void): Promise<StopSpeech>;
  stop(): void;
}

/** Read ~15% faster than default; matches the Sarvam TTS pace. */
const PLAYBACK_RATE = 1.15;
const STREAM_CONTENT_TYPE = 'audio/mpeg';
/** Approximately +1.9 dB to match the fuller batch-WAV acknowledgment level. */
export const STREAM_PLAYBACK_GAIN = 1.25;
const STREAM_LIMITER_THRESHOLD_DB = -1;

interface StreamPlaybackGraph {
  resume(): Promise<void>;
  close(): void;
}

function stoppedError(): DOMException {
  return new DOMException('Speech playback was stopped.', 'AbortError');
}

function unavailablePreparedStream(error: Error): PreparedSpeechStream {
  return {
    ready: Promise.reject(error),
    async play() {
      throw error;
    },
    stop() {
      // Nothing was started.
    },
  };
}

/**
 * Boost only the streamed MP3 path. Batch WAV clips already play at the
 * desired level; a near-0 dB limiter prevents the make-up gain from clipping.
 */
function createStreamPlaybackGraph(element: HTMLAudioElement): StreamPlaybackGraph | null {
  if (typeof AudioContext === 'undefined') return null;

  let context: AudioContext | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  try {
    context = new AudioContext();
    source = context.createMediaElementSource(element);
    gain = context.createGain();
    limiter = context.createDynamicsCompressor();
    gain.gain.value = STREAM_PLAYBACK_GAIN;
    limiter.threshold.value = STREAM_LIMITER_THRESHOLD_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    source.connect(gain);
    gain.connect(limiter);
    limiter.connect(context.destination);
  } catch {
    source?.disconnect();
    gain?.disconnect();
    limiter?.disconnect();
    if (context && context.state !== 'closed') void context.close();
    return null;
  }

  let closed = false;
  return {
    async resume() {
      if (context?.state === 'suspended') await context.resume();
    },
    close() {
      if (closed) return;
      closed = true;
      source?.disconnect();
      gain?.disconnect();
      limiter?.disconnect();
      if (context && context.state !== 'closed') void context.close();
    },
  };
}

export function speakWithBrowser(
  text: string,
  language: string,
  onEnded: () => void,
): StopSpeech {
  const synthesis = window.speechSynthesis;
  synthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language;
  utterance.rate = PLAYBACK_RATE;
  const matchingVoice = synthesis.getVoices().find((voice) => voice.lang === language);
  if (matchingVoice) utterance.voice = matchingVoice;

  let active = true;
  const finish = () => {
    if (!active) return;
    active = false;
    onEnded();
  };
  utterance.addEventListener('end', finish, { once: true });
  utterance.addEventListener('error', finish, { once: true });
  synthesis.speak(utterance);

  return () => {
    if (!active) return;
    active = false;
    synthesis.cancel();
  };
}

/** Play an already-generated speech clip without another provider round-trip. */
export async function playSpeechBlob(
  audio: Blob,
  onEnded: () => void = () => undefined,
): Promise<StopSpeech> {
  const url = URL.createObjectURL(audio);
  const element = new Audio(url);
  let active = true;

  const finish = () => {
    if (!active) return;
    active = false;
    URL.revokeObjectURL(url);
    onEnded();
  };
  element.addEventListener('ended', finish, { once: true });
  element.addEventListener('error', finish, { once: true });

  try {
    await element.play();
  } catch (error) {
    active = false;
    URL.revokeObjectURL(url);
    throw error;
  }

  return () => {
    if (!active) return;
    active = false;
    element.pause();
    URL.revokeObjectURL(url);
  };
}

/**
 * Prepare a Sarvam MP3 stream in a MediaSource so synthesis can run in the
 * background while the queue preserves sentence playback order.
 */
export function prepareSpeechStream(startStream: StartSpeechStream): PreparedSpeechStream {
  if (
    typeof MediaSource === 'undefined'
    || !MediaSource.isTypeSupported(STREAM_CONTENT_TYPE)
  ) {
    return unavailablePreparedStream(new Error('Progressive MP3 playback is unavailable.'));
  }

  const controller = new AbortController();
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const element = new Audio(url);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let sourceBuffer: SourceBuffer | null = null;
  let streamFinished = false;
  let firstChunkAppended = false;
  let stopped = false;
  let cleaned = false;
  let playbackGraph: StreamPlaybackGraph | null = null;
  let failure: unknown;
  let onPlaybackEnded: (() => void) | null = null;
  let onPlaybackError: ((error: unknown) => void) | null = null;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const cleanup = (pause: boolean) => {
    if (cleaned) return;
    cleaned = true;
    stopped = true;
    controller.abort();
    if (pause) element.pause();
    playbackGraph?.close();
    playbackGraph = null;
    URL.revokeObjectURL(url);
  };

  const reportFailure = (error: unknown) => {
    if (stopped || failure !== undefined) return;
    failure = error;
    if (!firstChunkAppended) rejectReady(error);
    const handler = onPlaybackError;
    if (handler) {
      onPlaybackError = null;
      onPlaybackEnded = null;
      cleanup(true);
      handler(error);
    }
  };

  const finishMediaSource = () => {
    if (
      stopped
      || !streamFinished
      || chunks.length > 0
      || sourceBuffer?.updating
      || mediaSource.readyState !== 'open'
    ) return;
    try {
      mediaSource.endOfStream();
    } catch (error) {
      reportFailure(error);
    }
  };

  const appendNextChunk = () => {
    if (stopped || !sourceBuffer || sourceBuffer.updating) return;
    const chunk = chunks.shift();
    if (!chunk) {
      finishMediaSource();
      return;
    }
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (error) {
      reportFailure(error);
    }
  };

  const handleSourceOpen = () => {
    if (stopped) return;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(STREAM_CONTENT_TYPE);
      sourceBuffer.addEventListener('updateend', () => {
        if (!firstChunkAppended) {
          firstChunkAppended = true;
          resolveReady();
        }
        appendNextChunk();
      });
      sourceBuffer.addEventListener('error', () => {
        reportFailure(new Error('Progressive speech buffer failed.'));
      });
      appendNextChunk();
    } catch (error) {
      reportFailure(error);
    }
  };

  element.addEventListener('ended', () => {
    if (stopped) return;
    const handler = onPlaybackEnded;
    onPlaybackEnded = null;
    onPlaybackError = null;
    cleanup(false);
    handler?.();
  }, { once: true });
  element.addEventListener('error', () => {
    reportFailure(new Error('Progressive speech playback failed.'));
  }, { once: true });
  mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });

  void startStream((audio) => {
    if (stopped || audio.byteLength === 0) return;
    chunks.push(audio);
    appendNextChunk();
  }, controller.signal).then(() => {
    if (stopped) return;
    streamFinished = true;
    if (!firstChunkAppended && chunks.length === 0) {
      reportFailure(new Error('Sarvam streaming TTS returned no audio.'));
      return;
    }
    finishMediaSource();
  }).catch((error) => {
    if (controller.signal.aborted || stopped) return;
    reportFailure(error);
  });

  return {
    ready,
    async play(onEnded, onError) {
      await ready;
      if (stopped) throw stoppedError();
      if (failure !== undefined) throw failure;
      await element.play();
      playbackGraph = createStreamPlaybackGraph(element);
      try {
        await playbackGraph?.resume();
      } catch (error) {
        cleanup(true);
        throw error;
      }
      if (stopped) {
        element.pause();
        throw stoppedError();
      }
      if (failure !== undefined) {
        element.pause();
        throw failure;
      }
      onPlaybackEnded = onEnded;
      onPlaybackError = onError;
      return () => cleanup(true);
    },
    stop() {
      if (!firstChunkAppended) rejectReady(stoppedError());
      cleanup(true);
    },
  };
}

/** Plays Sarvam audio when available, with speechSynthesis as the free UI fallback. */
export async function speakAnswer(
  text: string,
  language: string,
  onEnded: () => void = () => undefined,
): Promise<StopSpeech> {
  try {
    const { audio } = await defaultProviders().speak({ text, language });
    return await playSpeechBlob(audio, onEnded);
  } catch {
    return speakWithBrowser(text, language, onEnded);
  }
}
