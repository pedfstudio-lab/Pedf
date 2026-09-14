import { beforeEach, describe, expect, it } from 'vitest';
import {
  setPendingFile,
  setPendingProject,
  takePendingFile,
  takePendingProject,
} from './pendingFile';

describe('pending PDF handoff', () => {
  beforeEach(() => {
    takePendingFile();
    takePendingProject();
  });

  it('returns a pending file once', () => {
    const file = new File(['pdf'], 'brochure.pdf', { type: 'application/pdf' });

    setPendingFile(file);

    expect(takePendingFile()).toBe(file);
    expect(takePendingFile()).toBeUndefined();
  });

  it('returns a pending saved-project id once', () => {
    setPendingProject('saved-contract');

    expect(takePendingProject()).toBe('saved-contract');
    expect(takePendingProject()).toBeUndefined();
  });
});
