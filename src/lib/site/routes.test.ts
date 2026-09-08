import { describe, expect, it } from 'vitest';
import { resolveRoute } from './routes';

describe('resolveRoute', () => {
  it.each([
    ['/', '', 'landing'],
    ['/app', '', 'app'],
    ['/app/', '', 'app'],
    ['/privacy', '', 'privacy'],
    ['/terms', '', 'terms'],
    ['/support', '', 'support'],
    ['/nope', '', 'landing'],
    ['/', '#verify', 'verify'],
  ] as const)('maps %s %s to %s', (pathname, hash, expected) => {
    expect(resolveRoute(pathname, hash)).toBe(expected);
  });
});
