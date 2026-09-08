import { beforeEach, describe, expect, it } from 'vitest';
import { setPendingFile, takePendingFile } from './pendingFile';

describe('pending PDF handoff', () => {
  beforeEach(() => {
    takePendingFile();
  });

  it('returns a pending file once', () => {
    const file = new File(['pdf'], 'brochure.pdf', { type: 'application/pdf' });

    setPendingFile(file);

    expect(takePendingFile()).toBe(file);
    expect(takePendingFile()).toBeUndefined();
  });
});
