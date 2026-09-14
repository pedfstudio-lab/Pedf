import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[jt]sx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

describe('local tools privacy guard', () => {
  it('keeps network APIs out of tool processing and UI source', () => {
    const files = [
      ...sources(resolve('src/lib/tools')),
      ...sources(resolve('src/components/tools')),
      ...sources(resolve('src/lib/projects')),
    ];
    expect(files.length).toBeGreaterThan(0);
    const forbidden = /\bfetch\s*\(|\bXMLHttpRequest\b|\bnavigator\s*\.\s*sendBeacon\b/;
    const violations = files.filter((file) => forbidden.test(readFileSync(file, 'utf8')));
    expect(violations).toEqual([]);
  });
});
