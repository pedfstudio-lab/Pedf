import { describe, expect, it } from 'vitest';
import { passwordProblem } from './password';
import { lockProblem, parseLockOptions } from '@/lib/tools/lockOptions';

describe('lock passwords', () => {
  it('requires a nonempty matching password of at least eight characters', () => {
    expect(passwordProblem('', '')).toMatch(/Set a password/);
    expect(passwordProblem('short', 'short')).toMatch(/at least 8/);
    expect(passwordProblem('        ', '        ')).toMatch(/at least 8/);
    expect(passwordProblem('Good password!', 'different')).toMatch(/do not match/);
    expect(passwordProblem('Good password!', 'Good password!')).toBeUndefined();
  });
  it('keeps meaningful spaces, and rejects silent truncation or normalization', () => {
    expect(passwordProblem(' passphrase ', 'passphrase')).toMatch(/do not match/);
    expect(passwordProblem(' passphrase ', ' passphrase ')).toBeUndefined();
    expect(passwordProblem('a'.repeat(127), 'a'.repeat(127))).toBeUndefined();
    expect(passwordProblem('a'.repeat(128), 'a'.repeat(128))).toMatch(/too long/);
    expect(passwordProblem('🔒'.repeat(32), '🔒'.repeat(32))).toMatch(/too long/);
    for (const value of ['password\0', 'password\n', 'password\u200b', 'Ｆｕｌｌｗｉｄｔｈ']) expect(passwordProblem(value, value)).toMatch(/ordinary letters/);
  });
  it('accepts normal multilingual passphrases and safely parses malformed options', () => {
    expect(passwordProblem('Hindi पासवर्ड 2026!', 'Hindi पासवर्ड 2026!')).toBeUndefined();
    expect(parseLockOptions({ password: 123, confirmation: {} })).toEqual({ password: '', confirmation: '' });
    expect(lockProblem({ password: 'Good password!', confirmation: 'Good password!' },
      [{ size: 100 * 1024 ** 2 + 1 } as File])).toMatch(/smaller than 100 MB/);
  });
});
