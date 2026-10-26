import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockPdf } from './client';

class FakeWorker {
  static last: FakeWorker;
  terminate = vi.fn();
  postMessage = vi.fn();
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  onmessageerror?: () => void;
  constructor() { FakeWorker.last = this; }
  reply(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
beforeEach(() => { vi.stubGlobal('Worker', FakeWorker); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Lock PDF worker lifecycle', () => {
  it('returns the result, forwards progress, and terminates its isolated worker', async () => {
    const input = new Uint8Array([1, 2, 3]), progress = vi.fn();
    const promise = lockPdf(input, 'test passphrase', new AbortController().signal, progress);
    const worker = FakeWorker.last;
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage.mock.calls[0]![0].password).toBe('test passphrase');
    worker.reply({ type: 'progress', phase: 'encrypting' });
    worker.reply({ type: 'done', bytes: new Uint8Array([4, 5]).buffer });
    expect(await promise).toEqual(new Uint8Array([4, 5]));
    expect(input).toEqual(new Uint8Array([1, 2, 3]));
    expect(progress).toHaveBeenCalledWith('encrypting');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('terminates immediately on cancellation and ignores late results', async () => {
    const controller = new AbortController();
    const promise = lockPdf(new Uint8Array([1]), 'test passphrase', controller.signal);
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    FakeWorker.last.reply({ type: 'done', bytes: new ArrayBuffer(1) });
    await rejection;
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it('does not create a worker for an already cancelled request', () => {
    const controller = new AbortController(); controller.abort();
    expect(() => lockPdf(new Uint8Array([1]), 'test passphrase', controller.signal)).toThrow();
  });
  it('returns safe known errors and does not expose raw worker diagnostics', async () => {
    const promise = lockPdf(new Uint8Array([1]), 'test passphrase', new AbortController().signal);
    const rejection = expect(promise).rejects.toMatchObject({ code: 'failed' });
    const preventDefault = vi.fn();
    FakeWorker.last.onerror?.({ message: 'secret raw diagnostic', preventDefault } as unknown as ErrorEvent);
    await rejection;
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it('handles an explicit refusal and a worker timeout', async () => {
    const first = lockPdf(new Uint8Array([1]), 'test passphrase', new AbortController().signal);
    FakeWorker.last.reply({ type: 'error', code: 'signed' });
    await expect(first).rejects.toMatchObject({ code: 'signed' });
    const second = lockPdf(new Uint8Array([1]), 'test passphrase', new AbortController().signal);
    const rejection = expect(second).rejects.toMatchObject({ code: 'failed' });
    vi.advanceTimersByTime(120_000);
    await rejection;
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });
});
