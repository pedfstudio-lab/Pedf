import type { PagePreviewSelection } from '@/lib/export/exportPagePreview';

export type PagePreviewState = 'original' | 'committed' | 'preparing-edit' | 'editing' | 'committing' | 'fallback';

export interface PagePreviewBridge {
  readonly state: PagePreviewState;
  readonly renderedEditIds: ReadonlySet<string>;
  readonly reason?: string;
  begin(selection: PagePreviewSelection, invalidateEditor?: () => void): void;
  warm(selection: PagePreviewSelection): void;
  cancel(): void;
  commit(closeEditor: () => void): void;
  suspend(value: boolean): void;
}

/** Deduplicate warmed work and reject late completions; it never knows about edit history. */
export class PagePreviewController<Value> {
  private generation = 0;
  private cache = new Map<string, Promise<Value>>();
  constructor(private readonly limit = 2, private readonly release?: (value: Value) => void) {}

  warm(key: string, produce: () => Promise<Value>): Promise<Value> {
    let result = this.cache.get(key);
    if (result) { this.cache.delete(key); this.cache.set(key, result); return result; }
    result = produce();
    this.cache.set(key, result);
    void result.catch(() => { if (this.cache.get(key) === result) this.cache.delete(key); });
    while (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next().value as string;
      const evicted = this.cache.get(oldest)!;
      this.cache.delete(oldest);
      void evicted.then((value) => this.release?.(value)).catch(() => undefined);
    }
    return result;
  }

  async request(key: string, produce: () => Promise<Value>, accept: (value: Value) => void, fail: (error: unknown) => void): Promise<void> {
    const generation = ++this.generation;
    try {
      const value = await this.warm(key, produce);
      if (generation === this.generation) accept(value);
    } catch (error) { if (generation === this.generation) fail(error); }
  }

  invalidate(): void { this.generation += 1; }
  clear(): void {
    this.invalidate();
    for (const result of this.cache.values()) void result.then((value) => this.release?.(value)).catch(() => undefined);
    this.cache.clear();
  }
}
