import { beforeEach, describe, expect, it } from 'vitest';
import { setPendingFiles, takePendingFiles } from './pendingFiles';
import { setPendingFile, takePendingFile } from './pendingFile';

describe('pending file list', () => {
  const one = new File(['one'], 'one.pdf');
  const two = new File(['two'], 'two.pdf');
  beforeEach(() => { takePendingFiles(); });

  it('takes an ordered snapshot once without keeping the caller array', () => {
    const inputs = [one, two];
    setPendingFiles(inputs);
    inputs.pop();
    expect(takePendingFiles()).toEqual([one, two]);
    expect(takePendingFiles()).toEqual([]);
  });

  it('replaces the previous pending list', () => {
    setPendingFiles([one]);
    setPendingFiles([two]);
    expect(takePendingFiles()).toEqual([two]);
  });

  it('shares state with the single-file compatibility wrapper', () => {
    setPendingFile(one);
    expect(takePendingFiles()).toEqual([one]);
    setPendingFiles([one, two]);
    expect(takePendingFile()).toBe(one);
    expect(takePendingFiles()).toEqual([]);
  });
});
