import { describe, expect, it, vi } from 'vitest';

import {
  BARGE_IN_ARM_DELAY_MS,
  BARGE_IN_MIN_MS,
  BARGE_IN_SPEECH_RMS,
  createBargeInVad,
  createVad,
  DEFAULT_VAD_FRAME_MS,
  pcm16Rms,
} from './vad';

function pcmFrame(amplitude: number, samples = 80): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(samples * 2));
  const view = new DataView(bytes.buffer);
  const value = Math.round(Math.max(-1, Math.min(1, amplitude)) * 0x7fff);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, value, true);
  }
  return bytes;
}

describe('pcm16Rms', () => {
  it('reads normalized PCM16 energy and tolerates empty input', () => {
    expect(pcm16Rms(pcmFrame(0.5))).toBeCloseTo(0.5, 3);
    expect(pcm16Rms(new Uint8Array())).toBe(0);
  });
});

describe('createVad', () => {
  it('uses hysteresis and ends speech only after continuous silence', () => {
    const vad = createVad({ speechRms: 0.1, silenceMs: 300, frameMs: 100 });
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    vad.onSpeechStart = onSpeechStart;
    vad.onSpeechEnd = onSpeechEnd;

    vad.pushFrame(pcmFrame(0.02));
    vad.pushFrame(pcmFrame(0.2));
    vad.pushFrame(pcmFrame(0.2));
    expect(onSpeechStart).toHaveBeenCalledOnce();

    vad.pushFrame(pcmFrame(0));
    vad.pushFrame(pcmFrame(0));
    expect(onSpeechEnd).not.toHaveBeenCalled();
    vad.pushFrame(pcmFrame(0.08));
    vad.pushFrame(pcmFrame(0));
    vad.pushFrame(pcmFrame(0));
    expect(onSpeechEnd).not.toHaveBeenCalled();
    vad.pushFrame(pcmFrame(0));
    expect(onSpeechEnd).toHaveBeenCalledOnce();
  });

  it('reset discards in-progress speech without firing an end event', () => {
    const vad = createVad({ speechRms: 0.1, silenceMs: 100, frameMs: 100 });
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    vad.onSpeechStart = onSpeechStart;
    vad.onSpeechEnd = onSpeechEnd;

    vad.pushFrame(pcmFrame(0.2));
    vad.reset();
    vad.pushFrame(pcmFrame(0));
    vad.pushFrame(pcmFrame(0.2));

    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    expect(onSpeechEnd).not.toHaveBeenCalled();
  });

  it('arms late and requires sustained loud speech for a barge-in', () => {
    const vad = createBargeInVad();
    const onSpeechStart = vi.fn();
    vad.onSpeechStart = onSpeechStart;
    const armFrames = BARGE_IN_ARM_DELAY_MS / DEFAULT_VAD_FRAME_MS;
    const speechFrames = BARGE_IN_MIN_MS / DEFAULT_VAD_FRAME_MS;

    for (let index = 0; index < armFrames; index += 1) {
      vad.pushFrame(pcmFrame(BARGE_IN_SPEECH_RMS * 2));
    }
    expect(onSpeechStart).not.toHaveBeenCalled();

    for (let index = 0; index < speechFrames - 1; index += 1) {
      vad.pushFrame(pcmFrame(BARGE_IN_SPEECH_RMS * 2));
    }
    expect(onSpeechStart).not.toHaveBeenCalled();
    vad.pushFrame(pcmFrame(BARGE_IN_SPEECH_RMS * 2));
    expect(onSpeechStart).toHaveBeenCalledOnce();
  });

  it('rejects sub-threshold audio and resets a too-short loud blip', () => {
    const vad = createVad({
      speechRms: 0.1,
      minSpeechMs: 400,
      armDelayMs: 200,
      frameMs: 100,
    });
    const onSpeechStart = vi.fn();
    vad.onSpeechStart = onSpeechStart;

    vad.pushFrame(pcmFrame(0.5));
    vad.pushFrame(pcmFrame(0.5));
    vad.pushFrame(pcmFrame(0.09));
    vad.pushFrame(pcmFrame(0.2));
    vad.pushFrame(pcmFrame(0.2));
    vad.pushFrame(pcmFrame(0));
    vad.pushFrame(pcmFrame(0.2));
    vad.pushFrame(pcmFrame(0.2));
    vad.pushFrame(pcmFrame(0.2));
    expect(onSpeechStart).not.toHaveBeenCalled();
    vad.pushFrame(pcmFrame(0.2));
    expect(onSpeechStart).toHaveBeenCalledOnce();
  });
});
