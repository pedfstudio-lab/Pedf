import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TranscribeStreamSession } from '@/lib/providers/types';
import {
  startConversationSession,
} from './conversationSession';

function fakeTranscription() {
  return {
    ready: Promise.resolve(),
    pushAudio: vi.fn(),
    finish: vi.fn(),
    cancel: vi.fn(),
  } satisfies TranscribeStreamSession;
}

describe('startConversationSession', () => {
  afterEach(() => {
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
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const session = await startConversationSession(
      (partial) => {
        emitPartial = partial;
        return transcription;
      },
      { onPartial, onSpeechStart, onSpeechEnd },
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
    emitPartial?.('live words');
    vad.onSpeechStart?.();
    vad.onSpeechEnd?.();
    expect(transcription.pushAudio).toHaveBeenCalledWith(frame);
    expect(vad.pushFrame).toHaveBeenCalledWith(frame);
    expect(onPartial).toHaveBeenCalledWith('live words');
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(onSpeechEnd).toHaveBeenCalledOnce();

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
    expect(transcription.pushAudio).toHaveBeenCalledWith(frame);
    expect(vad.pushFrame).toHaveBeenCalledWith(frame);
    expect(vad.reset).toHaveBeenCalledTimes(2);

    await Promise.all([session.stop(), session.stop()]);
    expect(stopCapture).toHaveBeenCalledOnce();
    expect(transcription.cancel).toHaveBeenCalledOnce();
    expect(vad.reset).toHaveBeenCalledTimes(3);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('can replace the STT session without reopening or releasing the microphone', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const first = fakeTranscription();
    const second = fakeTranscription();
    let emitAudio: ((audio: Uint8Array<ArrayBuffer>) => void) | undefined;
    const session = await startConversationSession(
      () => first,
      {},
      async (_stream, onAudio) => {
        emitAudio = onAudio;
        return { stop: async () => undefined };
      },
    );

    await session.replaceTranscription(() => second);
    const frame = new Uint8Array(new ArrayBuffer(1));
    frame[0] = 7;
    emitAudio?.(frame);

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.pushAudio).toHaveBeenCalledWith(frame);
    expect(stopTrack).not.toHaveBeenCalled();

    await session.stop();
    expect(second.cancel).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
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
    expect(transcription.cancel).toHaveBeenCalledOnce();
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
