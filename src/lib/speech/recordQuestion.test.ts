import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseMimeType, startRecording } from './recordQuestion';

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

    const audio = await recording.stop();
    expect(audio.type).toBe('audio/webm');
    expect(audio.size).toBeGreaterThan(0);
    expect(stopTrack).toHaveBeenCalledOnce();
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
