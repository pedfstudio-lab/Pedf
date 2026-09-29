import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { detectRuleLines } from './ruleLines';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';

const baselinePath = 'tmp/tables/baseline.json';
const enabled = process.env.UNDECODABLE === '1' && existsSync(baselinePath);
if (!enabled) process.stdout.write('Undecodable-text sweep skipped: set UNDECODABLE=1.\n');

/**
 * Characters that cannot have come from real text: C0 and C1 controls, and the
 * replacement character. Tab, newline and carriage return are legitimate.
 * Checked by code point rather than by a regular expression, which would need
 * literal control characters in its source.
 */
function isUndecodable(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return false;
  if (codePoint <= 0x1f) return true;
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  return codePoint === 0xfffd;
}

function badChars(text: string): string[] {
  return [...text].filter((c) => isUndecodable(c.codePointAt(0) ?? 0));
}

describe.runIf(enabled)('blocks whose text cannot be decoded', () => {
  it('reports how many editable blocks contain undecodable characters', { timeout: 1_800_000 }, async () => {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as { files: Record<string, unknown> };
    const files = Object.keys(baseline.files).filter(existsSync);
    const extra = process.env.UNDECODABLE_FILE;
    if (extra && existsSync(extra)) files.push(extra);

    let totalBlocks = 0;
    let totalBad = 0;
    const affected: { file: string; bad: number; blocks: number; sample: string }[] = [];

    for (const file of files) {
      let blocksHere = 0;
      let badHere = 0;
      let sample = '';
      try {
        const reader = await getDocument({
          data: new Uint8Array(await readFile(file)),
          verbosity: 0,
        }).promise;
        for (let index = 0; index < reader.numPages; index += 1) {
          const page = await reader.getPage(index + 1);
          const runs = await extractTextRuns(page, index);
          const rules = await detectRuleLines(page, index);
          for (const block of groupRunsIntoBlocks(runs, { ruleLines: rules })) {
            blocksHere += 1;
            const bad = badChars(block.text);
            if (bad.length === 0) continue;
            badHere += 1;
            if (!sample) sample = JSON.stringify(block.text.slice(0, 40));
          }
        }
        await reader.destroy();
      } catch {
        continue;
      }
      totalBlocks += blocksHere;
      totalBad += badHere;
      if (badHere > 0) affected.push({ file, bad: badHere, blocks: blocksHere, sample });
    }

    process.stdout.write('\nUNDECODABLE TEXT SWEEP\n');
    process.stdout.write(`files ${files.length} | editable blocks ${totalBlocks}`
      + ` | blocks with undecodable characters ${totalBad}\n`);
    process.stdout.write(`files affected: ${affected.length} of ${files.length}\n`);
    for (const entry of affected.sort((a, b) => b.bad - a.bad)) {
      process.stdout.write(
        `  ${String(entry.bad).padStart(4)} of ${String(entry.blocks).padStart(4)} blocks`
        + `  ${entry.file}\n      ${entry.sample}\n`,
      );
    }
    expect(totalBlocks).toBeGreaterThan(0);
  });
});
