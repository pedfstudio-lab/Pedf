import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserProvider } from './browser';
import { ProviderChainError } from './errors';
import { clearProviderLog, getProviderLog } from './log';
import type { ProviderMethod, ProviderWithCapabilities } from './providerTypes';
import { createProviderChain, defaultProviders } from './index';
import type {
  DiscussInput,
  DiscussResult,
  ExplainInput,
  SpeakInput,
  SpeakResult,
  TextResult,
  TranscribeInput,
  TranslateInput,
} from './types';

interface FakeHandlers {
  readonly translate?: (input: TranslateInput) => Promise<TextResult>;
  readonly explain?: (input: ExplainInput) => Promise<TextResult>;
  readonly speak?: (input: SpeakInput) => Promise<SpeakResult>;
  readonly transcribe?: (input: TranscribeInput) => Promise<TextResult>;
  readonly discuss?: (input: DiscussInput) => Promise<DiscussResult>;
}

class FakeProvider implements ProviderWithCapabilities {
  constructor(
    readonly name: string,
    private readonly supported: readonly ProviderMethod[],
    private readonly handlers: FakeHandlers,
  ) {}

  supports(method: ProviderMethod): boolean {
    return this.supported.includes(method);
  }

  translate(input: TranslateInput): Promise<TextResult> {
    return this.handlers.translate?.(input) ?? Promise.reject(new Error('unexpected translate'));
  }

  explain(input: ExplainInput): Promise<TextResult> {
    return this.handlers.explain?.(input) ?? Promise.reject(new Error('unexpected explain'));
  }

  speak(input: SpeakInput): Promise<SpeakResult> {
    return this.handlers.speak?.(input) ?? Promise.reject(new Error('unexpected speak'));
  }

  transcribe(input: TranscribeInput): Promise<TextResult> {
    return this.handlers.transcribe?.(input) ?? Promise.reject(new Error('unexpected transcribe'));
  }

  discuss(input: DiscussInput): Promise<DiscussResult> {
    return this.handlers.discuss?.(input) ?? Promise.reject(new Error('unexpected discuss'));
  }
}

describe('createProviderChain', () => {
  beforeEach(() => {
    clearProviderLog();
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('falls through after an error and records both attempts', async () => {
    const first = new FakeProvider('first', ['speak'], {
      speak: async () => { throw new Error('temporary outage'); },
    });
    const expected = { audio: new Blob(['voice']), provider: 'second' };
    const second = new FakeProvider('second', ['speak'], {
      speak: async () => expected,
    });

    const result = await createProviderChain([first, second]).speak({
      text: 'hello',
      language: 'en-IN',
    });

    expect(result).toBe(expected);
    expect(getProviderLog()).toMatchObject([
      { provider: 'first', method: 'speak', ok: false },
      { provider: 'second', method: 'speak', ok: true },
    ]);
  });

  it('throws a clear aggregate error after all supporting providers fail', async () => {
    const failing = new FakeProvider('sarvam', ['discuss'], {
      discuss: async () => { throw new Error('service unavailable'); },
    });
    const browser = new BrowserProvider();

    const promise = createProviderChain([failing, browser]).discuss({
      question: 'When is check-in?',
      documentText: 'Check-in is at noon.',
    });

    await expect(promise).rejects.toMatchObject({
      name: 'ProviderChainError',
      method: 'discuss',
      errors: [expect.any(Error)],
    });
    await expect(promise).rejects.toThrow('All 1 supporting provider failed for discuss');
  });

  it('skips unsupported providers without logging them as errors', async () => {
    const unsupportedDiscuss = vi.fn<() => Promise<DiscussResult>>();
    const unsupported = new FakeProvider('browser-like', [], {
      discuss: unsupportedDiscuss,
    });
    const result: DiscussResult = { answer: 'At noon.', grounded: true, provider: 'sarvam' };
    const supporting = new FakeProvider('sarvam', ['discuss'], {
      discuss: async () => result,
    });

    await expect(createProviderChain([unsupported, supporting]).discuss({
      question: 'When?',
      documentText: 'At noon.',
    })).resolves.toBe(result);
    expect(unsupportedDiscuss).not.toHaveBeenCalled();
    expect(getProviderLog()).toMatchObject([
      { provider: 'sarvam', method: 'discuss', ok: true },
    ]);
  });

  it('uses the first supporting provider that succeeds and preserves order', async () => {
    const firstSpeak = vi.fn(async (): Promise<SpeakResult> => ({
      audio: new Blob(['first']),
      provider: 'first',
    }));
    const secondSpeak = vi.fn(async (): Promise<SpeakResult> => ({
      audio: new Blob(['second']),
      provider: 'second',
    }));
    const first = new FakeProvider('first', ['speak'], { speak: firstSpeak });
    const second = new FakeProvider('second', ['speak'], { speak: secondSpeak });

    const result = await createProviderChain([first, second]).speak({
      text: 'hello',
      language: 'en-IN',
    });

    expect(result.provider).toBe('first');
    expect(firstSpeak).toHaveBeenCalledOnce();
    expect(secondSpeak).not.toHaveBeenCalled();
  });

  it('reports when no configured provider supports a method', async () => {
    const browser = new BrowserProvider();
    const promise = createProviderChain([browser]).discuss({
      question: 'Why?',
      documentText: 'Because.',
    });

    await expect(promise).rejects.toBeInstanceOf(ProviderChainError);
    await expect(promise).rejects.toThrow('No configured provider supports discuss');
    expect(getProviderLog()).toEqual([]);
  });

  it('builds the fixed Sarvam-to-Browser default chain', async () => {
    const promise = defaultProviders().speak({ text: 'hello', language: 'en-IN' });

    await expect(promise).rejects.toThrow('All 1 supporting provider failed for speak');
    expect(getProviderLog()).toMatchObject([
      { provider: 'Sarvam', method: 'speak', ok: false },
    ]);
  });

  it('keeps default transcription Sarvam-only', async () => {
    const promise = defaultProviders().transcribe({ audio: new Blob(['voice']) });

    await expect(promise).rejects.toThrow('All 1 supporting provider failed for transcribe');
    expect(getProviderLog()).toMatchObject([
      { provider: 'Sarvam', method: 'transcribe', ok: false },
    ]);
  });
});

describe('BrowserProvider capabilities', () => {
  it('does not advertise provider-seam capabilities', () => {
    const browser = new BrowserProvider();
    expect(browser.supports('speak')).toBe(false);
    expect(browser.supports('transcribe')).toBe(false);
    expect(browser.supports('translate')).toBe(false);
    expect(browser.supports('explain')).toBe(false);
    expect(browser.supports('discuss')).toBe(false);
  });
});
