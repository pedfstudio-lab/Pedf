export interface VadOptions {
  readonly speechRms?: number;
  readonly silenceMs?: number;
  readonly frameMs?: number;
  /** Require this much continuous speech before firing onSpeechStart. */
  readonly minSpeechMs?: number;
  /** Ignore frames for this long after reset so playback onset cannot trigger speech. */
  readonly armDelayMs?: number;
}

export interface Vad {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  pushFrame(pcm: Uint8Array<ArrayBufferLike>): void;
  reset(): void;
}

export const DEFAULT_VAD_SPEECH_RMS = 0.025;
export const DEFAULT_VAD_SILENCE_MS = 400;
export const DEFAULT_VAD_FRAME_MS = 100;
export const BARGE_IN_SPEECH_RMS = 0.06;
export const BARGE_IN_MIN_MS = 400;
export const BARGE_IN_ARM_DELAY_MS = 500;
const SILENCE_THRESHOLD_RATIO = 0.6;

/** Compute normalized RMS energy from little-endian signed PCM16 samples. */
export function pcm16Rms(pcm: Uint8Array<ArrayBufferLike>): number {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, sampleCount * 2);
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const normalized = view.getInt16(index * 2, true) / 0x8000;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/** Local RMS VAD with hysteresis, fed by the existing realtime PCM capture. */
export function createVad(options: VadOptions = {}): Vad {
  const speechRms = options.speechRms ?? DEFAULT_VAD_SPEECH_RMS;
  const silenceRms = speechRms * SILENCE_THRESHOLD_RATIO;
  const silenceMs = options.silenceMs ?? DEFAULT_VAD_SILENCE_MS;
  const frameMs = options.frameMs ?? DEFAULT_VAD_FRAME_MS;
  const minSpeechMs = options.minSpeechMs ?? frameMs;
  const armDelayMs = options.armDelayMs ?? 0;
  let speaking = false;
  let accumulatedSilenceMs = 0;
  let accumulatedSpeechMs = 0;
  let accumulatedArmMs = 0;

  const vad: Vad = {
    pushFrame(pcm) {
      const rms = pcm16Rms(pcm);
      if (!speaking) {
        if (accumulatedArmMs < armDelayMs) {
          accumulatedArmMs += frameMs;
          accumulatedSpeechMs = 0;
          return;
        }
        if (rms < speechRms) {
          accumulatedSpeechMs = 0;
          return;
        }
        accumulatedSpeechMs += frameMs;
        if (accumulatedSpeechMs < minSpeechMs) return;
        speaking = true;
        accumulatedSpeechMs = 0;
        accumulatedSilenceMs = 0;
        vad.onSpeechStart?.();
        return;
      }

      if (rms > silenceRms) {
        accumulatedSilenceMs = 0;
        return;
      }

      accumulatedSilenceMs += frameMs;
      if (accumulatedSilenceMs < silenceMs) return;
      speaking = false;
      accumulatedSilenceMs = 0;
      vad.onSpeechEnd?.();
    },

    reset() {
      speaking = false;
      accumulatedSilenceMs = 0;
      accumulatedSpeechMs = 0;
      accumulatedArmMs = 0;
    },
  };

  return vad;
}

/** A deliberately strict detector for user speech heard over answer playback. */
export function createBargeInVad(): Vad {
  return createVad({
    speechRms: BARGE_IN_SPEECH_RMS,
    minSpeechMs: BARGE_IN_MIN_MS,
    armDelayMs: BARGE_IN_ARM_DELAY_MS,
    frameMs: DEFAULT_VAD_FRAME_MS,
  });
}
