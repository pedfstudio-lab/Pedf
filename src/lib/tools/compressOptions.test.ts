import { describe, expect, it } from 'vitest';
import { fileKey } from './organizePlan';
import {
  compressProblem,
  DEFAULT_COMPRESS_OPTIONS,
  limitBytes,
  parseCompressOptions,
} from './compressOptions';

describe('Compress PDF options', () => {
  it('uses Medium and a 500 KB target by default', () => {
    expect(parseCompressOptions({})).toEqual(DEFAULT_COMPRESS_OPTIONS);
    expect(parseCompressOptions({ level: 'smallest' }).level).toBe('smallest');
  });

  it('uses decimal portal limits and validates at least 20 KB', () => {
    expect(limitBytes({ limitValue: 500, limitUnit: 'KB' })).toBe(500_000);
    expect(limitBytes({ limitValue: 1.5, limitUnit: 'MB' })).toBe(1_500_000);
    expect(compressProblem({ ...DEFAULT_COMPRESS_OPTIONS, level: 'fit', limitValue: 19.99 })).toBe(
      'Enter a size limit of at least 20 KB.',
    );
    expect(compressProblem({ ...DEFAULT_COMPRESS_OPTIONS, level: 'fit', limitValue: 20 })).toBeUndefined();
  });

  it('waits for this file analysis and requires consent for a signed file', () => {
    const file = new File(['pdf'], 'signed.pdf', { type: 'application/pdf' });
    expect(compressProblem(DEFAULT_COMPRESS_OPTIONS, [file])).toBe('Checking the file…');
    const checked = { ...DEFAULT_COMPRESS_OPTIONS, analysisFileKey: fileKey(file), signed: true };
    expect(compressProblem(checked, [file])).toContain('digital signature');
    expect(compressProblem({ ...checked, acceptSignatureLoss: true }, [file])).toBeUndefined();
  });
});
