import type { TranscribeStreamSession } from '@/lib/providers/types';
import {
  createRealtimePcmCapture,
} from '@/lib/speech/recordQuestion';
import type {
  PcmCapture,
  PcmCaptureFactory,
} from '@/lib/speech/recordQuestion';
import { createVad } from '@/lib/speech/vad';
import type { Vad } from '@/lib/speech/vad';

export type ConversationPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface ConversationCallbacks {
  onPartial?(text: string): void;
  onFinal?(text: string): void;
  onSpeechStart?(): void;
  onSpeechEnd?(): void;
  onReconnect?(): void;
  onError?(error: unknown): void;
}

export type ConversationTranscriptionFactory = (
  onPartial: (text: string) => void,
  onFinal: (text: string) => void,
  onError: (error: unknown) => void,
) => TranscribeStreamSession;

export interface ConversationSession {
  /** The one microphone stream retained for the entire conversation. */
  readonly stream: MediaStream;
  /** Gate microphone frames without closing the persistent capture or STT socket. */
  setListening(listening: boolean): void;
  /** Flush the active utterance; its clean transcript arrives through onFinal. */
  requestFinal(): boolean;
  stop(): Promise<void>;
}

const CONVERSATION_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 4_000;

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function isRetryableTranscriptionError(error: unknown): boolean {
  return !(
    typeof error === 'object'
    && error !== null
    && 'retryable' in error
    && error.retryable === false
  );
}

/** Keep one mic/capture open and reconnect only if the persistent STT socket drops. */
export async function startConversationSession(
  startTranscription: ConversationTranscriptionFactory,
  callbacks: ConversationCallbacks,
  createPcmCapture: PcmCaptureFactory = createRealtimePcmCapture,
  vad: Vad = createVad(),
  reconnectBaseDelayMs = RECONNECT_BASE_DELAY_MS,
): Promise<ConversationSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone recording is not supported in this browser.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: CONVERSATION_AUDIO_CONSTRAINTS,
  });
  let transcription: TranscribeStreamSession | undefined;
  let pcmCapture: PcmCapture | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let stopped = false;
  let listening = true;
  let speaking = false;
  let stopPromise: Promise<void> | undefined;

  const onPartial = (text: string) => {
    if (!stopped) callbacks.onPartial?.(text);
  };
  const onFinal = (text: string) => {
    if (!stopped) callbacks.onFinal?.(text.trim());
  };
  vad.onSpeechStart = () => {
    speaking = true;
    if (!stopped) callbacks.onSpeechStart?.();
  };
  vad.onSpeechEnd = () => {
    speaking = false;
    if (!stopped) callbacks.onSpeechEnd?.();
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer === undefined) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== undefined) return;
    const delay = Math.min(
      reconnectBaseDelayMs * (2 ** reconnectAttempt),
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connectTranscription(false);
    }, delay);
  };

  const handleFailure = (
    source: TranscribeStreamSession,
    error: unknown,
    initial: boolean,
  ) => {
    if (stopped || transcription !== source) return;
    transcription = undefined;
    speaking = false;
    vad.reset();
    source.close();
    if (initial) return;
    if (isRetryableTranscriptionError(error)) scheduleReconnect();
    else callbacks.onError?.(error);
  };

  async function connectTranscription(initial: boolean): Promise<void> {
    if (stopped) return;
    let candidate: TranscribeStreamSession | undefined;
    let opening = initial;
    try {
      candidate = startTranscription(
        onPartial,
        onFinal,
        (error) => {
          if (candidate) handleFailure(candidate, error, opening);
        },
      );
      transcription = candidate;
      await candidate.ready;
      opening = false;
    } catch (error) {
      if (candidate && transcription === candidate) {
        transcription = undefined;
        candidate.close();
        speaking = false;
        vad.reset();
        if (!initial) {
          if (isRetryableTranscriptionError(error)) scheduleReconnect();
          else callbacks.onError?.(error);
        }
      } else if (!candidate && !initial) {
        if (isRetryableTranscriptionError(error)) scheduleReconnect();
        else callbacks.onError?.(error);
      }
      if (initial) throw error;
      return;
    }

    if (stopped || transcription !== candidate) {
      candidate.close();
      return;
    }
    reconnectAttempt = 0;
    if (!initial) callbacks.onReconnect?.();
  }

  try {
    await connectTranscription(true);
    pcmCapture = await createPcmCapture(stream, (audio) => {
      if (!listening) return;
      vad.pushFrame(audio);
      if (speaking) transcription?.pushAudio(audio);
    });
  } catch (error) {
    transcription?.close();
    await pcmCapture?.stop().catch(() => undefined);
    vad.reset();
    releaseStream(stream);
    callbacks.onError?.(error);
    throw error;
  }

  return {
    stream,

    setListening(next) {
      listening = next;
      speaking = false;
      vad.reset();
    },

    requestFinal() {
      if (stopped || !transcription) return false;
      speaking = false;
      void transcription.finish().catch(() => undefined);
      return true;
    },

    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      listening = false;
      speaking = false;
      clearReconnectTimer();
      stopPromise = (async () => {
        let stopError: unknown;
        try {
          await pcmCapture?.stop();
        } catch (error) {
          stopError = error;
        }
        transcription?.close();
        transcription = undefined;
        vad.reset();
        releaseStream(stream);
        if (stopError !== undefined) throw stopError;
      })();
      return stopPromise;
    },
  };
}
