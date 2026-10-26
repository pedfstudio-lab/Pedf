import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lockPdf } from '@/lib/lockPdf/client';
import { LockPdfError } from '@/lib/lockPdf/protocol';
import { lockTool, run } from './lock';

vi.mock('@/lib/lockPdf/client', () => ({ lockPdf: vi.fn() }));
const options = { password: 'My test passphrase!', confirmation: 'My test passphrase!' };
const file = (name = 'price-list.pdf') => new File(['%PDF-1.7 test'], name, { type: 'application/pdf' });
const context = (controller = new AbortController()) => ({ signal: controller.signal, onProgress: vi.fn() });
beforeEach(() => { vi.mocked(lockPdf).mockReset().mockResolvedValue(new Uint8Array([37, 80, 68, 70])); });

describe('Lock PDF tool', () => {
  it('returns a named protected download with no broken editor shortcut', async () => {
    const originalOptions = { ...options }, ctx = context();
    const [result] = await run([file()], originalOptions, ctx);
    expect(result).toMatchObject({ name: 'price-list-locked.pdf', mime: 'application/pdf', canOpenInEditor: false });
    expect(lockPdf).toHaveBeenCalledOnce();
    expect(lockPdf).toHaveBeenCalledWith(expect.any(Uint8Array), options.password, ctx.signal, expect.any(Function));
    expect(originalOptions).toEqual(options);
    expect(ctx.onProgress).toHaveBeenLastCalledWith(2, 2, 'Locked PDF ready');
    expect(lockTool.sensitiveOptions).toBe(true);
  });
  it('validates type, count, password and size before starting a worker', async () => {
    await expect(run([], options, context())).rejects.toThrow('Choose one PDF');
    await expect(run([file(), file()], options, context())).rejects.toThrow('Choose one PDF');
    await expect(run([new File(['image'], 'image.png', { type: 'image/png' })], options, context())).rejects.toThrow('Choose one PDF');
    await expect(run([file()], { password: 'password!', confirmation: 'wrong' }, context())).rejects.toThrow('do not match');
    expect(lockPdf).not.toHaveBeenCalled();
  });
  it('forwards only safe engine refusals and preserves cancellation', async () => {
    vi.mocked(lockPdf).mockRejectedValueOnce(new LockPdfError('locked'));
    await expect(run([file()], options, context())).rejects.toMatchObject({ userFacing: true });
    const controller = new AbortController(); controller.abort();
    await expect(run([file()], options, context(controller))).rejects.toMatchObject({ name: 'AbortError' });
    vi.mocked(lockPdf).mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
    await expect(run([file()], options, context())).rejects.toMatchObject({ name: 'AbortError' });
  });
});
