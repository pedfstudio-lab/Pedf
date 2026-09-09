// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { downloadBytes, zipOutputs } from './download';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('tool downloads', () => {
  it('zips output bytes losslessly, preserving duplicate names with suffixes', () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    const zipped = zipOutputs([
      { name: 'copy.pdf', bytes: first, mime: 'application/pdf' },
      { name: 'copy.pdf', bytes: second, mime: 'application/pdf' },
      { name: '../image.jpg', bytes: first, mime: 'image/jpeg' },
    ]);
    const extracted = unzipSync(zipped);
    expect(Object.keys(extracted)).toEqual(['copy.pdf', 'copy (2).pdf', 'image.jpg']);
    expect(extracted['copy.pdf']).toEqual(first);
    expect(extracted['copy (2).pdf']).toEqual(second);
    expect(extracted['image.jpg']).toEqual(first);
  });

  it('clicks a blob download, removes the anchor, and releases the URL after the click', () => {
    vi.useFakeTimers();
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:test');
    const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('result.pdf');
      expect(this.href).toBe('blob:test');
      expect(document.body.contains(this)).toBe(true);
      expect(revoke).not.toHaveBeenCalled();
    });

    downloadBytes('result.pdf', new Uint8Array([1, 2, 3]), 'application/pdf');

    expect(click).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });
});
