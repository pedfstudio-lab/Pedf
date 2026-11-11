import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every app colour comes from the colour list in index.css, named by its job, so a new
// colour set changes one place. These checks stop hue names and stray values creeping back.

function files(folder: string, pattern: RegExp): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name);
    return entry.isDirectory() ? files(path, pattern) : pattern.test(entry.name) ? [path] : [];
  });
}

const indexCss = readFileSync(resolve('src/index.css'), 'utf8');
const defined = new Set([...indexCss.matchAll(/^\s*(--color-[a-z0-9-]+):/gm)].map((match) => match[1]));
const code = files(resolve('src'), /\.[jt]sx?$/);
const styles = files(resolve('src'), /\.css$/).filter((file) => !file.endsWith('index.css'));
const utility = String.raw`\b(?:bg|text|border|ring-offset|ring|outline|from|to|via|fill|stroke|divide|placeholder|accent|caret|decoration|shadow)(?:-[trblxyse])?`;
const where = (file: string) => relative(resolve('.'), file).replaceAll('\\', '/');

describe('shared colour list', () => {
  it('uses job names, never Tailwind hue names, in class names', () => {
    const hue = new RegExp(`${utility}-(?:slate|gray|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}\\b`, 'g');
    const found = code.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(hue)].map((match) => `${where(file)}: ${match[0]}`));
    expect(found).toEqual([]);
  });

  it('defines every colour class the editor uses', () => {
    const job = new RegExp(`${utility}-((?:brand|neutral|success|warning|danger|addtext|image|crop|line|translate|voice)-\\d{2,3})\\b`, 'g');
    const used = new Set(code.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(job)].map((match) => `--color-${match[1]}`)));
    expect(used.size).toBeGreaterThan(50);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it('defines every colour the website CSS asks for', () => {
    const asked = styles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/var\((--color-[a-z0-9-]+)/g)].map((match) => [where(file), match[1]] as const));
    expect(asked.length).toBeGreaterThan(100);
    expect(asked.filter(([, name]) => !defined.has(name))).toEqual([]);
  });

  it('has no hue-named website colours left', () => {
    const old = styles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/--site-blue[a-z-]*/g)].map((match) => `${where(file)}: ${match[0]}`));
    expect(old).toEqual([]);
  });

  it('leaves the watermark colours, which go into the PDF, out of the list', () => {
    const tools = readFileSync(resolve('src/components/tools/tools.css'), 'utf8');
    expect(tools).toContain('.watermark-colour-blue { background: #1e6bff; }');
    expect(tools).toContain('.watermark-colour-red { background: #d32f2f; }');
  });
});
