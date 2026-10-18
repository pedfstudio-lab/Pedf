import { describe, expect, it, vi } from 'vitest';
import { PageTranslationCache, parseTranslationBatch, translationChunks, translationError, translationScale } from './pageTranslation';
import { indicEditMessage, indicLanguage, withoutIndicText } from './indicText';

describe('screen-only page translation', () => {
  it('chunks losslessly within the endpoint limit, including astral characters', () => {
    const text = 'A long sentence. '.repeat(350) + '😀'.repeat(2001);
    const chunks = translationChunks(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => [...chunk].length <= 2000)).toBe(true);
    expect(chunks.some(chunk => chunk.includes('\uFFFD'))).toBe(false);
  });
  it('batches boxes, reuses successful translations and distinguishes language/edited content', async () => {
    const provider = { translate: vi.fn(async ({ text }: { text: string }) => ({ text: text.replace(/Hello/g, 'नमस्ते').replace(/World/g, 'दुनिया'), provider: 'mock' })) };
    const cache = new PageTranslationCache(), boxes = [{ id: '1', text: 'Hello' }, { id: '2', text: 'World' }];
    expect([...(await cache.translate(boxes, 'hi-IN', provider)).values()]).toEqual(['नमस्ते', 'दुनिया']);
    await Promise.all([cache.translate(boxes, 'hi-IN', provider), cache.translate(boxes, 'hi-IN', provider)]);
    expect(provider.translate).toHaveBeenCalledTimes(1);
    await cache.translate(boxes, 'ta-IN', provider);
    expect(provider.translate).toHaveBeenCalledTimes(2);
    await cache.translate([{ id: '1', text: 'Edited' }], 'hi-IN', provider);
    expect(provider.translate).toHaveBeenCalledTimes(3);
    expect(provider.translate.mock.calls.every(([input]) => [...input.text].length <= 2000)).toBe(true);
  });
  it('never assigns an unstructured batch result to the wrong box', async () => {
    const provider = { translate: vi.fn().mockResolvedValueOnce({ text: 'markers lost' })
      .mockResolvedValueOnce({ text: 'पहला' }).mockResolvedValueOnce({ text: 'दूसरा' }) };
    const result = await new PageTranslationCache().translate([{ id: 'a', text: 'First' }, { id: 'b', text: 'Second' }], 'hi-IN', provider);
    expect([...result.values()]).toEqual(['पहला', 'दूसरा']);
    expect(provider.translate).toHaveBeenCalledTimes(3);
    expect(parseTranslationBatch('[[PEDF_BOX_1]] B [[PEDF_BOX_0]] A', 2)).toBeUndefined();
    expect(parseTranslationBatch('extra [[PEDF_BOX_0]] A', 1)).toBeUndefined();
  });
  it('retries failed work, bounds simultaneous pages, and stops queued offscreen work', async () => {
    const cache = new PageTranslationCache();
    const provider = { translate: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ text: 'ठीक' }) };
    await expect(cache.translate([{ id: 'a', text: 'Hello' }], 'hi-IN', provider)).rejects.toThrow('offline');
    await cache.translate([{ id: 'a', text: 'Hello' }], 'hi-IN', provider);
    const abort = new AbortController(); abort.abort();
    await expect(cache.translate([{ id: 'b', text: 'Other' }], 'hi-IN', provider, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.translate).toHaveBeenCalledTimes(2);
  });
  it('sends up to three requests at once, and the pages in view go before the next page', async () => {
    const started: string[] = [], finish = new Map<string, () => void>();
    const provider = { translate: vi.fn(({ text }: { text: string }) => {
      started.push(text[0]!);
      return new Promise<{ text: string; provider: string }>(resolve => finish.set(text[0]!, () => resolve({ text: `HI ${text[0]}`, provider: 'mock' })));
    }) };
    const cache = new PageTranslationCache(), long = (letter: string) => letter + 'x'.repeat(1500);
    const ahead = cache.translate(['A', 'B', 'C', 'D'].map(id => ({ id, text: long(id) })), 'hi-IN', provider, undefined, 1);
    const inView = cache.translate([{ id: 'V', text: long('V') }], 'hi-IN', provider, undefined, 0);
    await vi.waitFor(() => expect(started).toEqual(['A', 'B', 'C']));
    finish.get('A')!();
    await vi.waitFor(() => expect(started).toEqual(['A', 'B', 'C', 'V']));
    for (const letter of ['B', 'C', 'V']) finish.get(letter)!();
    await vi.waitFor(() => expect(started).toEqual(['A', 'B', 'C', 'V', 'D']));
    finish.get('D')!();
    expect((await inView).get('V')).toBe('HI V');
    expect([...(await ahead).values()]).toEqual(['HI A', 'HI B', 'HI C', 'HI D']);
  });
  it('after Sarvam says "too many" (429), retries once and continues one request at a time', async () => {
    let running = 0, most = 0, limited = false;
    const provider = { translate: vi.fn(async ({ text }: { text: string }) => {
      if (!limited && text.startsWith('A')) { limited = true; throw new Error('Translation request failed (429).'); }
      running += 1; if (limited) most = Math.max(most, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      return { text: `HI ${text[0]}`, provider: 'mock' };
    }) };
    const boxes = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, text: id + 'x'.repeat(1500) }));
    const result = await new PageTranslationCache().translate(boxes, 'hi-IN', provider);
    expect([...result.values()]).toEqual(['HI A', 'HI B', 'HI C', 'HI D', 'HI E']);
    expect(provider.translate).toHaveBeenCalledTimes(6);
    expect(most).toBeLessThanOrEqual(3);
    const later = vi.fn(async ({ text }: { text: string }) => { running += 1; most = Math.max(most, running);
      await new Promise(resolve => setTimeout(resolve, 5)); running -= 1; return { text, provider: 'mock' }; });
    most = 0;
    const cache = new PageTranslationCache();
    await cache.translate([{ id: 'x', text: 'A'.repeat(1500) }], 'hi-IN', { translate: vi.fn()
      .mockRejectedValueOnce(new Error('Translation request failed (429).')).mockResolvedValue({ text: 'ठीक', provider: 'mock' }) });
    await cache.translate(['F', 'G', 'H'].map(id => ({ id, text: id + 'y'.repeat(1500) })), 'hi-IN', { translate: later });
    expect(most).toBe(1);
  });
  it('two pages share one request, and a page scrolled away hands its request over', async () => {
    const provider = { translate: vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<{ text: string; provider: string }>((resolve, reject) => {
      if (provider.translate.mock.calls.length > 1) resolve({ text: 'नमस्ते', provider: 'mock' });
      signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')));
    })) };
    const cache = new PageTranslationCache(), away = new AbortController();
    const first = cache.translate([{ id: 'a', text: 'Hello' }], 'hi-IN', provider, away.signal);
    const second = cache.translate([{ id: 'b', text: 'Hello' }], 'hi-IN', provider);
    await vi.waitFor(() => expect(provider.translate).toHaveBeenCalledTimes(1));
    away.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect((await second).get('b')).toBe('नमस्ते');
    expect(provider.translate).toHaveBeenCalledTimes(2);
  });
  it('uses the full size when it fits, shrinks only as needed, and respects the 70% floor', () => {
    expect(translationScale(() => true)).toBe(1);
    expect(translationScale(scale => scale <= 0.85)).toBeCloseTo(0.85, 3);
    expect(translationScale(() => false)).toBe(0.7);
  });
  it('shows useful key errors through the provider chain, never arbitrary upstream details', () => {
    expect(translationError(new AggregateError([new Error('Translation needs a Sarvam key in Settings')]))).toBe('Translation needs a Sarvam key in Settings');
    expect(translationError(new Error('sensitive upstream detail'))).toBe("Couldn't translate this page — try again");
  });
});

describe('English-edit Indian-script guard', () => {
  it.each(['नमस्ते', 'தமிழ்', 'বাংলা', 'తెలుగు', 'मराठी', 'ગુજરાતી', 'ಕನ್ನಡ', 'മലയാളം', 'ਪੰਜਾਬੀ', 'ଓଡ଼ିଆ'])('recognises %s', text => {
    expect(indicLanguage(text)).toBeTruthy();
    expect(indicEditMessage(text)).toMatch(/^Editing supports English text/);
    expect(withoutIndicText(`Hello ${text}`)).toBe('Hello ');
  });
  it('does not reject English, prices, bullets or punctuation', () => {
    expect(indicEditMessage('Hello • Rs. 2,004/- ₹ 99.00 — 26th Dec')).toBeUndefined();
  });
});
