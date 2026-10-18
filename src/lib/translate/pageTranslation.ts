import type { PagePreviewSelection } from '@/lib/export/exportPagePreview';
import type { PdfRect, TextAlignment, TextStyle } from '@/lib/export/types';
import type { LanguageProvider } from '@/lib/providers/types';
import { TRANSLATE_MAX_CHARS, TRANSLATION_KEY_MESSAGE } from '@/lib/providers/sarvam';

export interface TranslationBox {
  readonly id: string;
  readonly text: string;
  readonly rect: PdfRect;
  readonly style: TextStyle;
  readonly align?: TextAlignment;
  /** A list marker is decoration, never something the translation service must preserve. */
  readonly prefix?: string;
  readonly selection?: PagePreviewSelection;
  readonly omitTextIds?: readonly string[];
}

export const TRANSLATION_FAILURE = "Couldn't translate this page — try again";
export const TRANSLATION_PRIVACY = 'Only page text is sent to Sarvam for translation. Your PDF file stays on this device. Translation is for reading only; Export stays English.';

export function translationError(error: unknown): string {
  if (error instanceof AggregateError) {
    if (error.errors.some(item => translationError(item) === TRANSLATION_KEY_MESSAGE)) return TRANSLATION_KEY_MESSAGE;
  }
  return error instanceof Error && error.message === TRANSLATION_KEY_MESSAGE ? TRANSLATION_KEY_MESSAGE : TRANSLATION_FAILURE;
}

/** Lossless chunks; count Unicode characters, never cut a surrogate pair. */
export function translationChunks(text: string, limit = TRANSLATE_MAX_CHARS): string[] {
  const chars = [...text], chunks: string[] = [];
  let offset = 0;
  while (offset < chars.length) {
    let count = Math.min(limit, chars.length - offset);
    if (offset + count < chars.length) {
      const window = chars.slice(offset, offset + count).join('');
      const breaks = [...window.matchAll(/(?:[.!?।]\s+|\n+|\s+)/gu)];
      const last = breaks.at(-1);
      if (last && last.index! >= window.length / 2) count = [...window.slice(0, last.index! + last[0].length)].length;
    }
    chunks.push(chars.slice(offset, offset + count).join(''));
    offset += count;
  }
  return chunks;
}

interface Segment { readonly text: string; readonly key: string }
const marker = (index: number) => `[[PEDF_BOX_${index}]]`;
const cacheKey = (text: string, language: string) => JSON.stringify([language, text]);

/** Sarvam requests in flight at once, across all pages; one at a time once Sarvam answers 429. */
export const TRANSLATE_PARALLEL = 3;
const RATE_LIMIT_PAUSE_MS = 1000;
/** Lower runs first: the pages in view (0) before the next page warmed up ahead of scrolling (1). */
export type TranslationPriority = number | (() => number);
interface Waiting { readonly priority: TranslationPriority; readonly order: number; start(): void }
const rank = (item: Waiting) => typeof item.priority === 'function' ? item.priority() : item.priority;
const stopped = () => new DOMException('Translation stopped.', 'AbortError');
const rateLimited = (error: unknown) => error instanceof Error && /\(429\)/.test(error.message);

function packBatches(segments: readonly Segment[]): Segment[][] {
  const batches: Segment[][] = [];
  let batch: Segment[] = [], size = 0;
  for (const segment of segments) {
    const labelled = (index: number) => [...`${marker(index)}\n${segment.text}\n`].length;
    if (batch.length && size + labelled(batch.length) > TRANSLATE_MAX_CHARS) { batches.push(batch); batch = []; size = 0; }
    size += labelled(batch.length); batch.push(segment);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Memory only, one instance per open PDF. Successful text is shared by pages and cards. */
export class PageTranslationCache {
  private readonly values = new Map<string, string>();
  // Text another page is already asking for: wait for it instead of asking twice.
  private readonly pending = new Map<string, Promise<void>>();
  private readonly waiting: Waiting[] = [];
  private running = 0;
  private order = 0;
  private parallel = TRANSLATE_PARALLEL;

  async translate(boxes: readonly Pick<TranslationBox, 'id' | 'text'>[], language: string,
    provider: Pick<LanguageProvider, 'translate'>, signal?: AbortSignal,
    priority: TranslationPriority = 0): Promise<ReadonlyMap<string, string>> {
    const wanted = new Map<string, string>();
    for (const box of boxes) for (const text of translationChunks(box.text)) {
      const key = cacheKey(text, language);
      if (!text.trim()) this.values.set(key, text); else wanted.set(key, text);
    }
    for (;;) {
      signal?.throwIfAborted();
      const missing = [...wanted].filter(([key]) => !this.values.has(key));
      if (!missing.length) break;
      // A shared request that failed (its page was scrolled away) is asked for again on the next pass.
      const shared = missing.flatMap(([key]) => this.pending.has(key) ? [this.pending.get(key)!] : []);
      const own = missing.filter(([key]) => !this.pending.has(key)).map(([key, text]) => ({ key, text }));
      await Promise.all([this.requestSegments(own, language, provider, priority, signal),
        ...shared.map(request => request.catch(() => undefined))]);
    }
    return new Map(boxes.map(box => [box.id, translationChunks(box.text)
      .map(text => this.values.get(cacheKey(text, language)) ?? '').join(' ')]));
  }

  private async requestSegments(segments: readonly Segment[], language: string,
    provider: Pick<LanguageProvider, 'translate'>, priority: TranslationPriority, signal?: AbortSignal): Promise<void> {
    if (!segments.length) return;
    const settle = new Map<string, (error?: unknown) => void>();
    for (const segment of segments) {
      const request = new Promise<void>((resolve, reject) => settle.set(segment.key, error => {
        if (this.pending.get(segment.key) === request) this.pending.delete(segment.key);
        if (error === undefined) resolve(); else reject(error);
      }));
      request.catch(() => undefined);
      this.pending.set(segment.key, request);
    }
    const store = (segment: Segment, text: string) => { this.values.set(segment.key, text); settle.get(segment.key)!(); };
    const ask = (text: string) => this.request(text, language, provider, priority, signal);
    const results = await Promise.allSettled(packBatches(segments).map(async batch => {
      if (batch.length === 1) { store(batch[0]!, await ask(batch[0]!.text)); return; }
      const parsed = parseTranslationBatch(await ask(batch.map((part, index) => `${marker(index)}\n${part.text}\n`).join('')), batch.length);
      if (parsed) batch.forEach((part, index) => store(part, parsed[index]!));
      // The endpoint has no structured batch response. Never guess which box
      // an unlabelled translation belongs to; safely retry each snippet.
      else await Promise.all(batch.map(async part => store(part, await ask(part.text))));
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    for (const segment of segments) if (!this.values.has(segment.key)) settle.get(segment.key)!(failure?.reason ?? stopped());
    if (failure) throw failure.reason;
  }

  private async request(text: string, language: string, provider: Pick<LanguageProvider, 'translate'>,
    priority: TranslationPriority, signal?: AbortSignal): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      await this.slot(priority, signal);
      try {
        return (await provider.translate({ text, to: language, from: 'en-IN', signal })).text;
      } catch (error) {
        if (attempt > 0 || signal?.aborted || !rateLimited(error)) throw error;
        this.parallel = 1;
      } finally { this.free(); }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, RATE_LIMIT_PAUSE_MS);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(stopped()); }, { once: true });
      });
    }
  }

  private slot(priority: TranslationPriority, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(stopped());
    if (this.running < this.parallel && !this.waiting.length) { this.running += 1; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const leave = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(stopped());
      };
      const entry: Waiting = { priority, order: this.order++, start: () => { signal?.removeEventListener('abort', leave); resolve(); } };
      signal?.addEventListener('abort', leave, { once: true });
      this.waiting.push(entry);
    });
  }

  private free(): void {
    this.running -= 1;
    while (this.running < this.parallel && this.waiting.length) {
      this.waiting.sort((left, right) => rank(left) - rank(right) || left.order - right.order);
      this.running += 1;
      this.waiting.shift()!.start();
    }
  }
}

export function parseTranslationBatch(text: string, count: number): string[] | undefined {
  const matches = [...text.matchAll(/\[\[PEDF_BOX_(\d+)\]\]/g)];
  if (matches.length !== count || text.slice(0, matches[0]?.index).trim()) return undefined;
  const parts = matches.map((match, index) => match[1] === String(index)
    ? text.slice(match.index! + match[0].length, matches[index + 1]?.index).trim() : '');
  return parts.every(Boolean) ? parts : undefined;
}

export function pageTranslationSelection(boxes: readonly TranslationBox[]): PagePreviewSelection | undefined {
  const selections = boxes.flatMap(box => box.selection ? [box.selection] : []);
  if (!selections.length) return undefined;
  return { key: JSON.stringify(boxes.map(box => [box.id, box.text])),
    transientEdits: selections.flatMap(selection => selection.transientEdits),
    coverIds: [...new Set(selections.flatMap(selection => selection.coverIds))],
    omitTextIds: [...new Set(boxes.flatMap(box => [...(box.selection?.omitTextIds ?? []), ...(box.omitTextIds ?? [])]))],
    paintSupported: selections.every(selection => selection.paintSupported),
    ...(selections.find(selection => selection.unsafeReason)?.unsafeReason
      ? { unsafeReason: selections.find(selection => selection.unsafeReason)!.unsafeReason } : {}),
  };
}

/** Choose the largest fitting scale, never below the task's 70% floor. */
export function translationScale(fits: (scale: number) => boolean): number {
  if (fits(1)) return 1;
  if (!fits(0.7)) return 0.7;
  let low = 0.7, high = 1;
  for (let index = 0; index < 12; index++) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle; else high = middle;
  }
  return low;
}

export const scriptFonts: Readonly<Record<string, string>> = {
  'hi-IN': '"Nirmala UI", Mangal, sans-serif', 'mr-IN': '"Nirmala UI", Mangal, sans-serif',
  'ta-IN': '"Nirmala UI", Latha, sans-serif', 'bn-IN': '"Nirmala UI", Vrinda, sans-serif',
  'te-IN': '"Nirmala UI", Vani, sans-serif', 'gu-IN': '"Nirmala UI", Shruti, sans-serif',
  'kn-IN': '"Nirmala UI", Tunga, sans-serif', 'ml-IN': '"Nirmala UI", Kartika, sans-serif',
  'pa-IN': '"Nirmala UI", Raavi, sans-serif',
};
