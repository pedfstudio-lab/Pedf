import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, mergeRunsIntoLines, type TextRun } from './textContent';

const baselinePath = 'tmp/tables/baseline.json';
const enabled = process.env.TASK74_GAPS === '1' && existsSync(baselinePath);
if (!enabled) {
  process.stdout.write('Word-gap measurement skipped: set TASK74_GAPS=1.\n');
}

// Helvetica's space advance, the font the export draws with today.
const SPACE_EM = 0.278;

function spacesForGap(gap: number, sizePt: number): number {
  const spaceWidth = SPACE_EM * sizePt;
  if (spaceWidth <= 0) return 1;
  return Math.max(1, Math.round(gap / spaceWidth));
}

function joinToday(runs: readonly TextRun[]): string {
  const [first, ...rest] = runs;
  if (!first) return '';
  let text = first.text.trim();
  let previous = first;
  for (const run of rest) {
    const part = run.text.trim();
    if (!part) continue;
    const gap = run.rect.x - (previous.rect.x + previous.rect.w);
    const threshold = Math.max(0.75, Math.min(previous.style.fontSizePt, run.style.fontSizePt) * 0.08);
    const punctuation = /^[,.;:!?%)}\]]/.test(part) || '([{/'.includes(text.at(-1) ?? '');
    if (gap > threshold && !punctuation) text += ' ';
    text += part;
    previous = run;
  }
  return text;
}

interface Tally {
  joins: number;
  unchanged: number;
  widened: number;
  buckets: Map<number, number>;
  lines: number;
  changedLines: number;
  samples: string[];
}

describe.runIf(enabled)('word gaps across the corpus', () => {
  it('reports how many merged gaps would widen', { timeout: 1_800_000 }, async () => {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as {
      files: Record<string, unknown>;
    };
    const tally: Tally = {
      joins: 0,
      unchanged: 0,
      widened: 0,
      buckets: new Map(),
      lines: 0,
      changedLines: 0,
      samples: [],
    };
    const perFile: { file: string; changed: number; lines: number }[] = [];

    for (const file of Object.keys(baseline.files)) {
      if (!existsSync(file)) continue;
      let changedHere = 0;
      let linesHere = 0;
      try {
        const data = new Uint8Array(await readFile(file));
        const doc = await getDocument({ data, useSystemFonts: false, disableFontFace: true }).promise;
        for (let index = 0; index < doc.numPages; index += 1) {
          const page = await doc.getPage(index + 1);
          const runs = await extractTextRuns(page, index);
          const lines = mergeRunsIntoLines(runs);
          for (const line of lines) {
            linesHere += 1;
            tally.lines += 1;
            const members = line.runs ?? [];
            if (members.length < 2) continue;
            let lineChanged = false;
            let rebuilt = members[0]?.text.trim() ?? '';
            let previous = members[0];
            for (const run of members.slice(1)) {
              const part = run.text.trim();
              if (!part || !previous) continue;
              const gap = run.rect.x - (previous.rect.x + previous.rect.w);
              const size = Math.min(previous.style.fontSizePt, run.style.fontSizePt);
              const threshold = Math.max(0.75, size * 0.08);
              const punctuation =
                /^[,.;:!?%)}\]]/.test(part) || '([{/'.includes(rebuilt.at(-1) ?? '');
              if (gap > threshold && !punctuation) {
                tally.joins += 1;
                const count = spacesForGap(gap, size);
                tally.buckets.set(count, (tally.buckets.get(count) ?? 0) + 1);
                if (count === 1) tally.unchanged += 1;
                else {
                  tally.widened += 1;
                  lineChanged = true;
                }
                rebuilt += ' '.repeat(count);
              }
              rebuilt += part;
              previous = run;
            }
            if (lineChanged) {
              changedHere += 1;
              tally.changedLines += 1;
              if (tally.samples.length < 25) {
                tally.samples.push(
                  `  today  ${JSON.stringify(joinToday(members))}\n  after  ${JSON.stringify(rebuilt)}`,
                );
              }
            }
          }
        }
        await doc.destroy();
      } catch (error) {
        process.stdout.write(`  unreadable ${file}: ${String(error).slice(0, 80)}\n`);
        continue;
      }
      perFile.push({ file, changed: changedHere, lines: linesHere });
    }

    const sorted = [...tally.buckets.entries()].sort((a, b) => a[0] - b[0]);
    process.stdout.write('\nTASK74_GAPS\n');
    process.stdout.write(`files ${perFile.length}\n`);
    process.stdout.write(`lines total ${tally.lines} | lines that change ${tally.changedLines}\n`);
    process.stdout.write(
      `gaps that get a space ${tally.joins} | stay at 1 ${tally.unchanged} | widen ${tally.widened}\n`,
    );
    process.stdout.write('spaces inserted:\n');
    for (const [count, n] of sorted) {
      process.stdout.write(`  ${String(count).padStart(3)} spaces  ${n}\n`);
    }
    process.stdout.write('\nfiles with the most changed lines:\n');
    for (const entry of [...perFile].sort((a, b) => b.changed - a.changed).slice(0, 10)) {
      process.stdout.write(`  ${entry.changed} / ${entry.lines}  ${entry.file}\n`);
    }
    process.stdout.write('\nsamples:\n');
    for (const sample of tally.samples) process.stdout.write(`${sample}\n`);
    expect(tally.lines).toBeGreaterThan(0);
  });
});
