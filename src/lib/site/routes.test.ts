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
    ['/index.html', '', 'landing'],
    ['/nope', '', 'notFound'],
    ['/compres', '', 'notFound'],
    ['/', '#verify', 'verify'],
  ] as const)('maps %s %s to %s', (pathname, hash, expected) => {
    expect(resolveRoute(pathname, hash)).toBe(expected);
  });

  it.each(['/tools', '/tools/'])('maps %s to the tools index', (path) => {
    expect(resolveRoute(path, '')).toEqual({ kind: 'tools' });
  });

  it.each(['/tools/copy', '/tools/copy/'])('maps %s to a tool without importing its implementation', (path) => {
    expect(resolveRoute(path, '')).toEqual({ kind: 'tool', slug: 'copy' });
  });

  it.each(['/tools/nested/path', '/tools/%2e%2e', '/tools/Merge'])('treats malformed tool paths as not a page', (path) => {
    expect(resolveRoute(path, '')).toBe('notFound');
  });
});
