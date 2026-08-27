import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TranscribeStreamSession } from '@/lib/providers/types';
import {
  startConversationSession,
} from './conversationSession';

function fakeTranscription(finalText = 'clean final') {
  return {
    ready: Promise.resolve(),
    pushAudio: vi.fn(),
    finish: vi.fn(async () => ({ text: finalText, provider: 'Sarvam' })),
    close: vi.fn(),
  } satisfies TranscribeStreamSession;
}

describe('startConversationSession', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens one enhanced mic stream, forwards PCM and partials, and stops once', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const transcription = fakeTranscription();
    let emitAudio: ((audio: Uint8Array<ArrayBuffer>) => void) | undefined;
    let emitPartial: ((text: string) => void) | undefined;
    let emitFinal: ((text: string) => void) | undefined;
    const stopCapture = vi.fn(async () => undefined);
    const vad = {
      pushFrame: vi.fn(),
      reset: vi.fn(),
      onSpeechStart: undefined as (() => void) | undefined,
      onSpeechEnd: undefined as (() => void) | undefined,
    };
    const createPcmCapture = vi.fn(async (
      _stream: MediaStream,
      onAudio: (audio: Uint8Array<ArrayBuffer>) => void,
    ) => {
      emitAudio = onAudio;
      return { stop: stopCapture };
    });
    const onPartial = vi.fn();
    const onFinal = vi.fn();
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const session = await startConversationSession(
      (partial, final) => {
        emitPartial = partial;
        emitFinal = final;
        return transcription;
      },
      { onPartial, onFinal, onSpeechStart, onSpeechEnd },
      createPcmCapture,
      vad,
    );

    expect(session.stream).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    expect(createPcmCapture).toHaveBeenCalledWith(stream, expect.any(Function));

    const frame = new Uint8Array(new ArrayBuffer(2));
    frame.set([1, 2]);
    emitAudio?.(frame);
    expect(vad.pushFrame).toHaveBeenCalledWith(frame);
    expect(transcription.pushAudio).not.toHaveBeenCalled();

    vad.onSpeechStart?.();
    emitAudio?.(frame);
    emitPartial?.('live words');
    vad.onSpeechEnd?.();
    expect(transcription.pushAudio).toHaveBeenCalledWith(frame);
    expect(vad.pushFrame).toHaveBeenCalledTimes(2);
    expect(onPartial).toHaveBeenCalledWith('live words');
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(onSpeechEnd).toHaveBeenCalledOnce();
    expect(session.requestFinal()).toBe(true);
    emitFinal?.('  clean final  ');
    expect(onFinal).toHaveBeenCalledWith('clean final');

    transcription.pushAudio.mockClear();
    vad.pushFrame.mockClear();
    vad.reset.mockClear();
    session.setListening(false);
    emitAudio?.(frame);
    expect(transcription.pushAudio).not.toHaveBeenCalled();
    expect(vad.pushFrame).not.toHaveBeenCalled();
    expect(vad.reset).toHaveBeenCalledOnce();

    session.setListening(true);
    emitAudio?.(frame);
    expect(transcription.pushAudio).not.toHaveBeenCalled();
    expect(vad.pushFrame).toHaveBeenCalledWith(frame);

    vad.onSpeechStart?.();
    emitAudio?.(frame);
    expect(transcription.pushAudio).toHaveBeenCalledWith(frame);
    expect(vad.pushFrame).toHaveBeenCalledTimes(2);
    expect(vad.reset).toHaveBeenCalledTimes(2);

    await Promise.all([session.stop(), session.stop()]);
    expect(stopCapture).toHaveBeenCalledOnce();
    expect(transcription.close).toHaveBeenCalledOnce();
    expect(vad.reset).toHaveBeenCalledTimes(3);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('flushes a rolling three-frame pre-roll before speech and clears it between turns', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });
    const transcription = fakeTranscription();
    let emitAudio: ((audio: Uint8Array<ArrayBuffer>) => void) | undefined;
    let detectSpeech = false;
    const vad = {
      pushFrame: vi.fn(),
      reset: vi.fn(),
      onSpeechStart: undefined as (() => void) | undefined,
      onSpeechEnd: undefined as (() => void) | undefined,
    };
    vad.pushFrame.mockImplementation(() => {
      if (!detectSpeech) return;
      detectSpeech = false;
      vad.onSpeechStart?.();
    });
    const session = await startConversationSession(
      () => transcription,
      {},
      async (_stream, onAudio) => {
        emitAudio = onAudio;
        return { stop: async () => undefined };
      },
      vad,
    );
    const frame = (value: number) => {
      const audio = new Uint8Array(new ArrayBuffer(2));
      audio.set([value, value]);
      return audio;
    };

    emitAudio?.(frame(1));
    emitAudio?.(frame(2));
    emitAudio?.(frame(3));
    emitAudio?.(frame(4));
    expect(transcription.pushAudio).not.toHaveBeenCalled();

    detectSpeech = true;
    emitAudio?.(frame(5));
    expect(transcription.pushAudio.mock.calls.map(([audio]) => [...audio])).toEqual([
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]);

    transcription.pushAudio.mockClear();
    session.setListening(false);
    session.setListening(true);
    emitAudio?.(frame(6));
    session.setListening(false);
    session.setListening(true);
    detectSpeech = true;
    emitAudio?.(frame(7));
    expect(transcription.pushAudio.mock.calls.map(([audio]) => [...audio])).toEqual([
      [7, 7],
    ]);

    await session.stop();
  });

  it('watches muted playback without feeding STT and captures only live audio after barge-in', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });
    const transcription = fakeTranscription();
    let emitAudio: ((audio: Uint8Array<ArrayBuffer>) => void) | undefined;
    const vad = {
      pushFrame: vi.fn(),
      reset: vi.fn(),
      onSpeechStart: undefined as (() => void) | undefined,
      onSpeechEnd: undefined as (() => void) | undefined,
    };
    const bargeVad = {
      pushFrame: vi.fn(),
      reset: vi.fn(),
      onSpeechStart: undefined as (() => void) | undefined,
      onSpeechEnd: undefined as (() => void) | undefined,
    };
    let normalSpeechDetected = false;
    vad.pushFrame.mockImplementation(() => {
      if (normalSpeechDetected) return;
      normalSpeechDetected = true;
      vad.onSpeechStart?.();
    });
    const holder: { current?: Awaited<ReturnType<typeof startConversationSession>> } = {};
    const onBargeIn = vi.fn(() => holder.current?.setListening(true));
    const session = await startConversationSession(
      () => transcription,
      { onBargeIn },
      async (_stream, onAudio) => {
        emitAudio = onAudio;
        return { stop: async () => undefined };
      },
      vad,
      undefined,
      bargeVad,
    );
    holder.current = session;

    session.setListening(false);
    const ignored = new Uint8Array(new ArrayBuffer(2));
    ignored.set([9, 9]);
    emitAudio?.(ignored);
    expect(vad.pushFrame).not.toHaveBeenCalled();
    expect(bargeVad.pushFrame).not.toHaveBeenCalled();
    expect(transcription.pushAudio).not.toHaveBeenCalled();

    session.setBargeInEnabled(true);
    const frames = Array.from({ length: 4 }, (_, index) => {
      const frame = new Uint8Array(new ArrayBuffer(2));
      frame.set([index + 1, index + 2]);
      return frame;
    });
    for (const frame of frames) emitAudio?.(frame);
    expect(bargeVad.pushFrame).toHaveBeenCalledTimes(4);
    expect(vad.pushFrame).not.toHaveBeenCalled();
    expect(transcription.pushAudio).not.toHaveBeenCalled();

    bargeVad.onSpeechStart?.();
    expect(onBargeIn).toHaveBeenCalledOnce();
    expect(vad.pushFrame).not.toHaveBeenCalled();
    expect(transcription.pushAudio).not.toHaveBeenCalled();

    const liveFrame = new Uint8Array(new ArrayBuffer(2));
    liveFrame.set([8, 9]);
    emitAudio?.(liveFrame);
    expect(vad.pushFrame).toHaveBeenCalledWith(liveFrame);
    expect(transcription.pushAudio).toHaveBeenCalledOnce();
    expect(transcription.pushAudio).toHaveBeenCalledWith(liveFrame);

    await session.stop();
  });

  it('uses one realtime socket across 30 utterances', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const transcription = fakeTranscription();
    let emitAudio: ((audio: Uint8Array<ArrayBuffer>) => void) | undefined;
    let emitFinal: ((text: string) => void) | undefined;
    const startTranscription = vi.fn((_partial, final: (text: string) => void) => {
      emitFinal = final;
      return transcription;
    });
    const onFinal = vi.fn();
    const vad = {
      pushFrame: vi.fn(),
      reset: vi.fn(),
      onSpeechStart: undefined as (() => void) | undefined,
      onSpeechEnd: undefined as (() => void) | undefined,
    };
    const session = await startConversationSession(
      startTranscription,
      { onFinal },
      async (_stream, onAudio) => {
        emitAudio = onAudio;
        return { stop: async () => undefined };
      },
      vad,
    );

    const frame = new Uint8Array(new ArrayBuffer(2));
    frame.set([0xff, 0x7f]);
    for (let turn = 1; turn <= 30; turn += 1) {
      vad.onSpeechStart?.();
      emitAudio?.(frame);
      vad.onSpeechEnd?.();
      expect(session.requestFinal()).toBe(true);
      emitFinal?.(`final ${turn}`);
    }

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(startTranscription).toHaveBeenCalledOnce();
    expect(transcription.pushAudio).toHaveBeenCalledTimes(30);
    expect(transcription.finish).toHaveBeenCalledTimes(30);
    expect(onFinal).toHaveBeenCalledTimes(30);
    expect(stopTrack).not.toHaveBeenCalled();

    await session.stop();
    expect(transcription.close).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('reconnects a dropped realtime socket and resumes forwarding speech', async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });
    const first = fakeTranscription();
    const second = fakeTranscription();
    const errors: Array<(error: unknown) => void> = [];
    const sessions = [first, second];
    const startTranscription = vi.fn((_partial, _final, onError: (error: unknown) => void) => {
      errors.push(onError);
      const next = sessions[startTranscription.mock.calls.length - 1];
      if (!next) throw new Error('unexpected reconnect');
      return next;
    });
    let emitAudio: ((audio: Uint8Array<ArrayBuffer>) => void) | undefined;
    const vad = {
      pushFrame: vi.fn(),
      reset: vi.fn(),
      onSpeechStart: undefined as (() => void) | undefined,
      onSpeechEnd: undefined as (() => void) | undefined,
    };
    const onReconnect = vi.fn();
    const onError = vi.fn();
    const session = await startConversationSession(
      startTranscription,
      { onReconnect, onError },
      async (_stream, onAudio) => {
        emitAudio = onAudio;
        return { stop: async () => undefined };
      },
      vad,
      10,
    );

    errors[0]?.(Object.assign(new Error('network blip'), { retryable: true }));
    expect(first.close).toHaveBeenCalledOnce();
    expect(startTranscription).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);

    expect(startTranscription).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    vad.onSpeechStart?.();
    const frame = new Uint8Array(new ArrayBuffer(2));
    frame.set([0xff, 0x7f]);
    emitAudio?.(frame);
    expect(second.pushAudio).toHaveBeenCalledWith(frame);

    await session.stop();
  });

  it('reports setup failure and releases every resource', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });
    const transcription = fakeTranscription();
    const onError = vi.fn();

    await expect(startConversationSession(
      () => transcription,
      { onError },
      async () => { throw new Error('PCM unavailable'); },
    )).rejects.toThrow('PCM unavailable');

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'PCM unavailable' }));
    expect(transcription.close).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('surfaces a denied microphone without starting transcription', async () => {
    const denied = new DOMException('Denied', 'NotAllowedError');
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => { throw denied; }) },
    });
    const startTranscription = vi.fn();

    await expect(startConversationSession(
      startTranscription,
      {},
    )).rejects.toBe(denied);
    expect(startTranscription).not.toHaveBeenCalled();
  });
});
