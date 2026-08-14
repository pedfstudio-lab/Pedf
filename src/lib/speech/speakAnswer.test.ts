import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { speakAnswer } from './speakAnswer';

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
  voice: SpeechSynthesisVoice | null = null;

  constructor(readonly text: string) {}

  addEventListener(type: string, listener: PlaybackListener): void {
    this.listeners.set(type, listener);
  }

  emit(type: string): void {
    this.listeners.get(type)?.();
  }
}

describe('speakAnswer', () => {
  beforeEach(() => {
    providerSpeak.mockReset();
    FakeAudio.instances = [];
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
    expect(utterance.voice).toBe(voice);

    stop();
    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
  });
});
