import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  playSpeechBlob,
  prepareSpeechStream,
  speakAnswer,
  STREAM_PLAYBACK_GAIN,
} from './speakAnswer';

const providerSpeak = vi.hoisted(() => vi.fn());

vi.mock('@/lib/providers', () => ({
  defaultProviders: () => ({ speak: providerSpeak }),
}));

type PlaybackListener = () => void;

class FakeAudio {
  static instances: FakeAudio[] = [];

  readonly listeners = new Map<string, PlaybackListener>();
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();

  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: PlaybackListener): void {
    this.listeners.set(type, listener);
  }

  emit(type: string): void {
    this.listeners.get(type)?.();
  }
}

class FakeUtterance {
  readonly listeners = new Map<string, PlaybackListener>();
  lang = '';
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;

  constructor(readonly text: string) {}

  addEventListener(type: string, listener: PlaybackListener): void {
    this.listeners.set(type, listener);
  }

  emit(type: string): void {
    this.listeners.get(type)?.();
  }
}

class FakeSourceBuffer {
  readonly listeners = new Map<string, PlaybackListener>();
  readonly appended: Uint8Array[] = [];
  updating = false;

  addEventListener(type: string, listener: PlaybackListener): void {
    this.listeners.set(type, listener);
  }

  appendBuffer(audio: Uint8Array): void {
    this.updating = true;
    this.appended.push(audio);
    this.updating = false;
    this.listeners.get('updateend')?.();
  }
}

class FakeMediaSource {
  static instances: FakeMediaSource[] = [];
  static readonly isTypeSupported = vi.fn(() => true);

  readonly listeners = new Map<string, PlaybackListener>();
  readonly sourceBuffer = new FakeSourceBuffer();
  readonly endOfStream = vi.fn(() => {
    this.readyState = 'ended';
  });
  readyState = 'closed';

  constructor() {
    FakeMediaSource.instances.push(this);
  }

  addEventListener(type: string, listener: PlaybackListener): void {
    this.listeners.set(type, listener);
  }

  addSourceBuffer(): FakeSourceBuffer {
    return this.sourceBuffer;
  }

  open(): void {
    this.readyState = 'open';
    this.listeners.get('sourceopen')?.();
  }
}

class FakeAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = { value: 1 };
}

class FakeLimiterNode extends FakeAudioNode {
  readonly threshold = { value: 0 };
  readonly knee = { value: 0 };
  readonly ratio = { value: 1 };
  readonly attack = { value: 0 };
  readonly release = { value: 0 };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  readonly destination = {};
  readonly source = new FakeAudioNode();
  readonly gain = new FakeGainNode();
  readonly limiter = new FakeLimiterNode();
  readonly createMediaElementSource = vi.fn(() => this.source);
  readonly createGain = vi.fn(() => this.gain);
  readonly createDynamicsCompressor = vi.fn(() => this.limiter);
  readonly resume = vi.fn(async () => {
    this.state = 'running';
  });
  readonly close = vi.fn(async () => {
    this.state = 'closed';
  });
  state: AudioContextState = 'suspended';

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

describe('speakAnswer', () => {
  beforeEach(() => {
    providerSpeak.mockReset();
    FakeAudio.instances = [];
    FakeMediaSource.instances = [];
    FakeAudioContext.instances = [];
    FakeMediaSource.isTypeSupported.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays provider audio, revokes its URL, and reports natural completion', async () => {
    providerSpeak.mockResolvedValue({
      audio: new Blob(['voice'], { type: 'audio/wav' }),
      provider: 'Sarvam',
    });
    const createObjectURL = vi.fn(() => 'blob:answer');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('Audio', FakeAudio);
    const onEnded = vi.fn();

    const stop = await speakAnswer('Hello', 'en-IN', onEnded);

    expect(providerSpeak).toHaveBeenCalledWith({ text: 'Hello', language: 'en-IN' });
    const audio = FakeAudio.instances[0];
    expect(audio?.src).toBe('blob:answer');
    expect(audio?.play).toHaveBeenCalledOnce();
    audio?.emit('ended');
    expect(onEnded).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:answer');

    stop();
    expect(audio?.pause).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('uses a matching browser voice when provider audio is unavailable', async () => {
    providerSpeak.mockRejectedValue(new Error('No key'));
    const voice = { lang: 'hi-IN' } as SpeechSynthesisVoice;
    const synthesis = {
      cancel: vi.fn(),
      getVoices: vi.fn(() => [voice]),
      speak: vi.fn(),
    };
    vi.stubGlobal('window', { speechSynthesis: synthesis });
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);

    const stop = await speakAnswer('नमस्ते', 'hi-IN');

    expect(synthesis.cancel).toHaveBeenCalledOnce();
    expect(synthesis.speak).toHaveBeenCalledOnce();
    const utterance = synthesis.speak.mock.calls[0]?.[0] as unknown as FakeUtterance;
    expect(utterance.text).toBe('नमस्ते');
    expect(utterance.lang).toBe('hi-IN');
    expect(utterance.rate).toBe(1.15);
    expect(utterance.voice).toBe(voice);

    stop();
    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
  });

  it('plays a cached blob without another provider request', async () => {
    const createObjectURL = vi.fn(() => 'blob:acknowledgment');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('Audio', FakeAudio);
    const onEnded = vi.fn();

    await playSpeechBlob(new Blob(['ack']), onEnded);

    expect(providerSpeak).not.toHaveBeenCalled();
    const audio = FakeAudio.instances[0];
    expect(audio?.src).toBe('blob:acknowledgment');
    audio?.emit('ended');
    expect(onEnded).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:acknowledgment');
  });

  it('starts progressive playback after the first streaming MP3 chunk is appended', async () => {
    const createObjectURL = vi.fn(() => 'blob:stream');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('MediaSource', FakeMediaSource);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    let sendChunk: ((audio: Uint8Array<ArrayBuffer>) => void) | undefined;
    let finishStream: (() => void) | undefined;
    let streamSignal: AbortSignal | undefined;
    const prepared = prepareSpeechStream((onAudioChunk, signal) => {
      sendChunk = onAudioChunk;
      streamSignal = signal;
      return new Promise<void>((resolve) => {
        finishStream = resolve;
      });
    });
    const mediaSource = FakeMediaSource.instances[0];
    mediaSource?.open();

    sendChunk?.(new Uint8Array([1, 2, 3]));
    await prepared.ready;
    const onEnded = vi.fn();
    const onError = vi.fn();
    const stop = await prepared.play(onEnded, onError);

    expect(mediaSource?.sourceBuffer.appended).toHaveLength(1);
    expect(FakeAudio.instances[0]?.play).toHaveBeenCalledOnce();
    const audioContext = FakeAudioContext.instances[0];
    if (!audioContext) throw new Error('Expected the streaming gain graph to be created.');
    expect(audioContext.createMediaElementSource).toHaveBeenCalledWith(FakeAudio.instances[0]);
    expect(audioContext.gain.gain.value).toBe(STREAM_PLAYBACK_GAIN);
    expect(audioContext.limiter.threshold.value).toBe(-1);
    expect(audioContext.source.connect).toHaveBeenCalledWith(audioContext.gain);
    expect(audioContext.gain.connect).toHaveBeenCalledWith(audioContext.limiter);
    expect(audioContext.limiter.connect).toHaveBeenCalledWith(audioContext.destination);
    expect(audioContext.resume).toHaveBeenCalledOnce();
    finishStream?.();
    await Promise.resolve();
    expect(mediaSource?.endOfStream).toHaveBeenCalledOnce();

    FakeAudio.instances[0]?.emit('ended');
    expect(onEnded).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:stream');
    expect(streamSignal?.aborted).toBe(true);
    expect(audioContext.close).toHaveBeenCalledOnce();

    stop();
    expect(FakeAudio.instances[0]?.pause).not.toHaveBeenCalled();
  });

  it('aborts both synthesis and playback through one progressive stop handle', async () => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:stream'),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('MediaSource', FakeMediaSource);
    let sendChunk: ((audio: Uint8Array<ArrayBuffer>) => void) | undefined;
    let streamSignal: AbortSignal | undefined;
    const prepared = prepareSpeechStream((onAudioChunk, signal) => {
      sendChunk = onAudioChunk;
      streamSignal = signal;
      return new Promise<void>(() => undefined);
    });
    FakeMediaSource.instances[0]?.open();
    sendChunk?.(new Uint8Array([4, 5, 6]));
    await prepared.ready;
    const stop = await prepared.play(vi.fn(), vi.fn());

    stop();

    expect(streamSignal?.aborted).toBe(true);
    expect(FakeAudio.instances[0]?.pause).toHaveBeenCalledOnce();
  });
});
