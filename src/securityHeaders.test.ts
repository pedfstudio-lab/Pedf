import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The browser safety rules Cloudflare sends with every page and file (public/_headers). */
function rules(): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of readFileSync(resolve('public/_headers'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    if (match) headers[match[1]!.toLowerCase()] = match[2]!.trim();
  }
  return headers;
}

function policy(): Map<string, string[]> {
  return new Map(rules()['content-security-policy']!.split(';').map((part) => part.trim().split(/\s+/)).filter((words) => words[0])
    .map(([name, ...values]) => [name!, values]));
}

describe('browser safety rules for highpal.ai', () => {
  it('apply to every page and file', () => {
    expect(readFileSync(resolve('public/_headers'), 'utf8')).toMatch(/^\/\*$/m);
  });

  it('let only HighPal\'s own code run, plus Cloudflare\'s human check and visitor counter', () => {
    const scripts = policy().get('script-src')!;
    expect(scripts).toEqual(["'self'", "'wasm-unsafe-eval'", 'https://challenges.cloudflare.com', 'https://static.cloudflareinsights.com']);
    expect(rules()['content-security-policy']).not.toMatch(/'unsafe-eval'|script-src[^;]*'unsafe-inline'/);
    expect(policy().get('object-src')).toEqual(["'none'"]);
    expect(policy().get('base-uri')).toEqual(["'self'"]);
    expect(policy().get('default-src')).toEqual(["'self'"]);
  });

  it('send data only to HighPal itself and those two Cloudflare services', () => {
    expect(policy().get('connect-src')).toEqual([
      "'self'", 'data:', 'blob:', 'https://challenges.cloudflare.com', 'https://cloudflareinsights.com', 'wss://highpal.ai', 'wss://www.highpal.ai',
    ]);
    expect(policy().get('frame-src')).toEqual(['https://challenges.cloudflare.com']);
  });

  it('stop other websites showing HighPal inside themselves (clickjacking)', () => {
    expect(policy().get('frame-ancestors')).toEqual(["'none'"]);
    expect(rules()['x-frame-options']).toBe('DENY');
  });

  it('keep browsers on HTTPS, stop file-type guessing, and trim what other sites learn', () => {
    expect(Number(rules()['strict-transport-security']!.match(/max-age=(\d+)/)?.[1])).toBeGreaterThanOrEqual(15552000);
    expect(rules()['x-content-type-options']).toBe('nosniff');
    expect(rules()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(rules()['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('allow the microphone only for HighPal (voice), and switch off camera and location', () => {
    const permissions = rules()['permissions-policy']!;
    expect(permissions).toContain('microphone=(self)');
    expect(permissions).toContain('camera=()');
    expect(permissions).toContain('geolocation=()');
  });
});
