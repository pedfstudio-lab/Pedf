import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unlockPdf } from './client';

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

describe('Unlock PDF worker lifecycle', () => {
  it('sends a copy of the file with the password, returns the unlocked bytes, and ends the worker', async () => {
    const input = new Uint8Array([1, 2, 3]);
    const promise = unlockPdf(input, 'RAHU1990');
    const worker = FakeWorker.last;
    expect(worker.postMessage.mock.calls[0]![0].password).toBe('RAHU1990');
    worker.reply({ type: 'done', bytes: new Uint8Array([4, 5]).buffer });
    expect(await promise).toEqual(new Uint8Array([4, 5]));
    expect(input).toEqual(new Uint8Array([1, 2, 3]));
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('passes on a wrong-password refusal and hides raw worker errors', async () => {
    const wrong = unlockPdf(new Uint8Array([1]), 'nope');
    FakeWorker.last.reply({ type: 'error', code: 'password' });
    await expect(wrong).rejects.toMatchObject({ code: 'password', message: "That password isn't right. Try again." });

    const broken = unlockPdf(new Uint8Array([1]), '');
    const rejection = expect(broken).rejects.toMatchObject({ code: 'failed' });
    const preventDefault = vi.fn();
    FakeWorker.last.onerror?.({ message: 'raw diagnostic', preventDefault } as unknown as ErrorEvent);
    await rejection;
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('stops on cancel or after two minutes', async () => {
    const controller = new AbortController();
    const cancelled = unlockPdf(new Uint8Array([1]), '', controller.signal);
    const cancelRejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelRejection;
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();

    const slow = unlockPdf(new Uint8Array([1]), '');
    const timeout = expect(slow).rejects.toMatchObject({ code: 'failed' });
    vi.advanceTimersByTime(120_000);
    await timeout;
  });
});
