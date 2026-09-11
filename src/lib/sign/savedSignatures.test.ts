// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSaved, listSaved, MAX_SAVED_SIGNATURES, saveSignature, SAVED_SIGNATURES_KEY } from './savedSignatures';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => localStorage.clear());

describe('saved signatures', () => {
  it('keeps at most five entries, newest first, and deletes by id', () => {
    for (let index = 0; index < 7; index++) {
      saveSignature({ id: String(index), label: `Signature ${index}`, pngDataUrl: PNG, createdAt: index });
    }
    const entries = listSaved();
    expect(entries).toHaveLength(MAX_SAVED_SIGNATURES);
    expect(entries.map(({ id }) => id)).toEqual(['6', '5', '4', '3', '2']);
    deleteSaved('4');
    expect(listSaved().map(({ id }) => id)).toEqual(['6', '5', '3', '2']);
  });

  it('ignores malformed data', () => {
    localStorage.setItem(SAVED_SIGNATURES_KEY, JSON.stringify([{ nope: true }]));
    expect(listSaved()).toEqual([]);
  });

  it('does not throw when storage is blocked', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(listSaved()).toEqual([]);
    expect(() => saveSignature({ label: 'Mine', pngDataUrl: PNG })).not.toThrow();
    expect(() => deleteSaved('mine')).not.toThrow();
    read.mockRestore();
  });
});
