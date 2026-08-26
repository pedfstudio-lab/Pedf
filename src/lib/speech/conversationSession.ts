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
  onSpeechStart?(): void;
  onSpeechEnd?(): void;
  onError?(error: unknown): void;
}

export type ConversationTranscriptionFactory = (
  onPartial: (text: string) => void,
  onError: (error: unknown) => void,
) => TranscribeStreamSession;

export interface ConversationSession {
  /** The one microphone stream retained for later VAD and barge-in stages. */
  readonly stream: MediaStream;
  /** Gate microphone frames without closing the persistent capture or STT socket. */
  setListening(listening: boolean): void;
  /** Swap only the STT socket while leaving the microphone and PCM capture open. */
  replaceTranscription(startTranscription: ConversationTranscriptionFactory): Promise<void>;
  stop(): Promise<void>;
}

const CONVERSATION_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Keep one mic/capture open and route its PCM frames through a replaceable STT session. */
export async function startConversationSession(
  startTranscription: ConversationTranscriptionFactory,
  callbacks: ConversationCallbacks,
  createPcmCapture: PcmCaptureFactory = createRealtimePcmCapture,
  vad: Vad = createVad(),
): Promise<ConversationSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone recording is not supported in this browser.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: CONVERSATION_AUDIO_CONSTRAINTS,
  });
  let transcription: TranscribeStreamSession | undefined;
  let pcmCapture: PcmCapture | undefined;
  let stopped = false;
  let listening = true;
  let stopPromise: Promise<void> | undefined;

  const onPartial = (text: string) => {
    if (!stopped) callbacks.onPartial?.(text);
  };
  const onError = (error: unknown) => {
    if (!stopped) callbacks.onError?.(error);
  };
  vad.onSpeechStart = () => {
    if (!stopped) callbacks.onSpeechStart?.();
  };
  vad.onSpeechEnd = () => {
    if (!stopped) callbacks.onSpeechEnd?.();
  };

  try {
    transcription = startTranscription(onPartial, onError);
    pcmCapture = await createPcmCapture(stream, (audio) => {
      if (!listening) return;
      transcription?.pushAudio(audio);
      vad.pushFrame(audio);
    });
    await transcription.ready;
  } catch (error) {
    transcription?.cancel();
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
      vad.reset();
    },

    async replaceTranscription(factory) {
      if (stopped) throw new Error('Conversation session is already stopped.');
      const previous = transcription;
      let next: TranscribeStreamSession | undefined;
      try {
        // Route new PCM into the next session immediately; it queues frames until ready.
        next = factory(onPartial, onError);
        transcription = next;
        await next.ready;
        if (stopped) {
          next.cancel();
          return;
        }
        previous?.cancel();
      } catch (error) {
        next?.cancel();
        if (!stopped) transcription = previous;
        onError(error);
        throw error;
      }
    },

    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      listening = false;
      stopPromise = (async () => {
        let stopError: unknown;
        try {
          await pcmCapture?.stop();
        } catch (error) {
          stopError = error;
        }
        transcription?.cancel();
        vad.reset();
        releaseStream(stream);
        if (stopError !== undefined) throw stopError;
      })();
      return stopPromise;
    },
  };
}
