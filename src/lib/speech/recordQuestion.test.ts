import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseMimeType, floatSamplesToPcm16, startRecording } from './recordQuestion';

type FakeRecorderEvent = { readonly data?: Blob };
type FakeRecorderListener = (event: FakeRecorderEvent) => void;

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static preferredSupported = true;
  static nextChunk = new Blob(['voice-frame'], { type: 'audio/webm;codecs=opus' });

  static isTypeSupported(type: string): boolean {
    return type === 'audio/webm;codecs=opus' && FakeMediaRecorder.preferredSupported;
  }

  readonly listeners = new Map<string, FakeRecorderListener[]>();
  readonly mimeType: string;
  state: RecordingState = 'inactive';

  constructor(
    readonly stream: MediaStream,
    readonly options?: MediaRecorderOptions,
  ) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, listener: FakeRecorderListener): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.emit('dataavailable', { data: FakeMediaRecorder.nextChunk });
      this.emit('stop', {});
    });
  }

  private emit(type: string, event: FakeRecorderEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('baseMimeType', () => {
  it.each([
    ['audio/webm;codecs=opus', 'audio/webm'],
    ['audio/webm', 'audio/webm'],
    ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'],
    ['', 'audio/webm'],
  ])('normalises %j to %j', (rawType, expected) => {
    expect(baseMimeType(rawType)).toBe(expected);
  });
});

describe('floatSamplesToPcm16', () => {
  it('clamps samples and writes signed little-endian PCM16', () => {
    const bytes = floatSamplesToPcm16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]));
    const view = new DataView(bytes.buffer);

    expect(Array.from({ length: 7 }, (_, index) => view.getInt16(index * 2, true))).toEqual([
      -32768,
      -32768,
      -16384,
      0,
      16384,
      32767,
      32767,
    ]);
  });
});

describe('startRecording', () => {
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);

  beforeEach(() => {
    stopTrack.mockClear();
    getUserMedia.mockClear();
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.preferredSupported = true;
    FakeMediaRecorder.nextChunk = new Blob(['voice-frame'], {
      type: 'audio/webm;codecs=opus',
    });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records WebM/Opus, waits for the final chunk, and releases the mic', async () => {
    const recording = await startRecording();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeMediaRecorder.instances[0]?.options).toEqual({
      mimeType: 'audio/webm;codecs=opus',
    });

    const result = await recording.stop();
    expect(result.audio.type).toBe('audio/webm');
    expect(result.audio.size).toBeGreaterThan(0);
    expect(result.streamingTranscript).toBeUndefined();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('streams PCM while retaining browser audio for the batch fallback', async () => {
    const pushAudio = vi.fn();
    const finish = vi.fn(async () => ({ text: '  what are the dates?  ', provider: 'Sarvam' }));
    const close = vi.fn();
    const stopPcm = vi.fn(async () => undefined);
    const frame = new Uint8Array(new ArrayBuffer(2));
    frame.set([1, 2]);
    const createPcmCapture = vi.fn(async (_stream, onAudio: (audio: Uint8Array<ArrayBuffer>) => void) => {
      onAudio(frame);
      return { stop: stopPcm };
    });

    const recording = await startRecording({
      startTranscription: () => ({
        ready: Promise.resolve(),
        pushAudio,
        finish,
        close,
      }),
      createPcmCapture,
    });
    const result = await recording.stop();

    expect(createPcmCapture).toHaveBeenCalledWith(stream, expect.any(Function));
    expect(pushAudio).toHaveBeenCalledWith(frame);
    expect(stopPcm).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(result.streamingTranscript).toBe('what are the dates?');
    expect(result.audio.size).toBeGreaterThan(0);
  });

  it('returns batch audio when the realtime transcript fails', async () => {
    const close = vi.fn();
    const recording = await startRecording({
      startTranscription: () => ({
        ready: Promise.resolve(),
        pushAudio: vi.fn(),
        finish: vi.fn(async () => { throw new Error('socket failed'); }),
        close,
      }),
      createPcmCapture: async () => ({ stop: async () => undefined }),
    });

    const result = await recording.stop();

    expect(result.streamingTranscript).toBeUndefined();
    expect(result.audio.size).toBeGreaterThan(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps recording when realtime PCM setup is unavailable', async () => {
    const close = vi.fn();
    const recording = await startRecording({
      startTranscription: () => ({
        ready: Promise.resolve(),
        pushAudio: vi.fn(),
        finish: vi.fn(),
        close,
      }),
      createPcmCapture: async () => { throw new Error('AudioWorklet unavailable'); },
    });

    await expect(recording.stop()).resolves.toMatchObject({
      audio: expect.any(Blob),
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('falls back to the recorder default and cancellation releases tracks once', async () => {
    FakeMediaRecorder.preferredSupported = false;
    const recording = await startRecording();

    expect(FakeMediaRecorder.instances[0]?.options).toBeUndefined();
    recording.cancel();
    recording.cancel();
    await Promise.resolve();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('cancels realtime capture together with the browser recording', async () => {
    const close = vi.fn();
    const stopPcm = vi.fn(async () => undefined);
    const recording = await startRecording({
      startTranscription: () => ({
        ready: Promise.resolve(),
        pushAudio: vi.fn(),
        finish: vi.fn(),
        close,
      }),
      createPcmCapture: async () => ({ stop: stopPcm }),
    });

    recording.cancel();
    recording.cancel();
    await Promise.resolve();

    expect(close).toHaveBeenCalledOnce();
    expect(stopPcm).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('rejects an empty recording after releasing the microphone', async () => {
    FakeMediaRecorder.nextChunk = new Blob([]);
    const recording = await startRecording();

    await expect(recording.stop()).rejects.toThrow('Recording is empty');
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('surfaces microphone permission failures', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));

    await expect(startRecording()).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(FakeMediaRecorder.instances).toEqual([]);
  });
});
