import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, mergeRunsIntoLines } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { composeTextLine, sourceLineComposition } from './lineComposition';
import { exportPdf } from '@/lib/export/exportPdf';
import type { Edit, TextEdit, TextStyle } from '@/lib/export/types';

const cases: Record<string, readonly [string, number]> = {
  'Bhutan caption': ["tmp/paragraphs/Bhutan December'26.pdf", 0],
  'Bhutan heading': ["tmp/paragraphs/Bhutan December'26.pdf", 0],
  'Ladakh paragraph': ['tmp/compress-tests/ladakh-original.pdf', 1],
  'Right heading': ['tmp/compress-tests/healing.pdf', 16],
  'Sri Lanka cells': ['tmp/tables/Firgun_QT-H4SNASRX_SriLanka.pdf', 0],
};
describe.runIf(process.env.TASK74_POSITION_123 === '1' && existsSync('tmp/5d/browser-changes123.json'))('Changes 1–3 browser commits exported in Node', () => {
  it('renders the recorded real edits and checks retained source origins exactly', async () => {
    const records = JSON.parse(await readFile('tmp/5d/browser-changes123.json', 'utf8')) as { fixture: string; committed: Edit[] }[];
    const reports = [];
    for (const [index, record] of records.entries()) {
      const fixture = cases[record.fixture]; if (!fixture) continue;
      const [file, pageIndex] = fixture, bytes = new Uint8Array(await readFile(file));
      const source = await getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
      try {
        const runs = await extractTextRuns(await source.getPage(pageIndex + 1), pageIndex);
        const refs = new Map<string, string>();
        for (const edit of record.committed) if (edit.kind === 'text') for (const piece of edit.composition?.pieces ?? []) {
          const run = runs.find(run => piece.sourceRect && ['x', 'y', 'w', 'h'].every(key => Math.abs(run.rect[key as keyof typeof run.rect] - piece.sourceRect![key as keyof typeof run.rect]) < 1e-8));
          if (run?.style.fontRef && piece.style.fontRef) refs.set(piece.style.fontRef, run.style.fontRef);
        }
        const style = (value: TextStyle) => ({ ...value, ...(value.fontRef && refs.has(value.fontRef) ? { fontRef: refs.get(value.fontRef) } : {}) });
        const edits = record.committed.map(edit => edit.kind !== 'text' ? edit : { ...edit, style: style(edit.style),
          ...(edit.composition ? { composition: { ...edit.composition, style: style(edit.composition.style), pieces: edit.composition.pieces.map(piece => ({ ...piece, style: style(piece.style) })) } } : {}) });
        const pages = await Promise.all(Array.from({ length: source.numPages }, async (_, pageIndex) => {
          const page = await source.getPage(pageIndex + 1), [x = 0, y = 0, right = 0, top = 0] = page.view;
          return { pageIndex, widthPt: right - x, heightPt: top - y, rotation: page.rotate as 0 | 90 | 180 | 270, boxOffset: { x, y } };
        }));
        const result = await exportPdf({ originalBytes: bytes, pages, edits });
        const path = `tmp/5d/position123-${index}.pdf`; await writeFile(path, result.bytes);
        const reader = await getDocument({ data: result.bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
        try {
          const after = await extractTextRuns(await reader.getPage(pageIndex + 1), pageIndex);
          const retained = edits.flatMap(edit => edit.kind === 'text' ? edit.composition?.pieces.filter(piece => piece.sourceVisible) ?? [] : []);
          for (const piece of retained) {
            const run = after.find(run => run.text === piece.text && run.metrics?.x === piece.source?.x && run.metrics?.baselineY === piece.source?.baselineY);
            expect(run, `${record.fixture}: retained ${piece.text}`).toBeDefined();
            expect(run!.rect).toEqual(piece.sourceRect);
          }
          if (record.fixture === 'Bhutan caption') {
            const texts = edits.filter((edit): edit is TextEdit => edit.kind === 'text');
            const pieces = texts[0]!.composition!.pieces;
            expect(pieces[0]!.x).toBe(82.27571618184501); expect(pieces[1]!.x).toBe(284.2362095168241);
            expect(pieces[1]!.x - pieces[0]!.x - pieces[0]!.widthPt).toBeCloseTo(50.26524840561457, 9);
            expect(pieces[2]!.x - pieces[1]!.x - pieces[1]!.widthPt).toBeCloseTo(50.26529265561271, 9);
          }
          reports.push({ fixture: record.fixture, path, retained: retained.length, removed: result.redaction.removedItems,
            fallbacks: edits.flatMap(edit => edit.kind === 'text' && edit.compositionFallback ? [edit.compositionFallback] : []) });
        } finally { await reader.destroy(); }
      } finally { await source.destroy(); }
    }
    await writeFile('tmp/5d/position123-exports.json', JSON.stringify(reports, null, 2));
    expect(reports.length).toBeGreaterThan(0);
  }, 120_000);
});

describe.runIf(process.env.TASK74_POSITION_CORPUS === '1')('Changes 1–3 source composition accounting', () => {
  it('names every source-line fallback without changing any extracted string', async () => {
    const frozen = JSON.parse(await readFile('tmp/5d/source-text-before.json', 'utf8')) as Record<string, { pageIndex: number; lines: string[] }[]>;
    const reasons: Record<string, number> = {}, byFile: Record<string, { composed: number; fallbacks: Record<string, number> }> = {};
    let pages = 0, lines = 0, composed = 0;
    for (const [file, entries] of Object.entries(frozen)) {
      const document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, fontExtraProperties: true }).promise;
      byFile[file] = { composed: 0, fallbacks: {} };
      try {
        for (const entry of entries) {
          const page = await document.getPage(entry.pageIndex + 1);
          const [runs, rules, regions] = await Promise.all([extractTextRuns(page, entry.pageIndex), detectRuleLines(page, entry.pageIndex), detectPageGraphicRegions(page, entry.pageIndex)]);
          const actual = mergeRunsIntoLines(runs, { ruleLines: rules, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
          expect(actual.map(line => line.text), `${file} p${entry.pageIndex + 1}`).toEqual(entry.lines);
          pages++; lines += actual.length;
          for (const line of actual) {
            const result = composeTextLine(sourceLineComposition(line), line.text, line.style, () => { throw Error('Unchanged text must not be remeasured'); });
            if ('composition' in result) {
              composed++; byFile[file]!.composed++;
              expect(result.composition.pieces.map(piece => [piece.text, piece.x, piece.baselineY, piece.widthPt])).toEqual(line.runs.map(run => [run.text, run.metrics!.x, run.metrics!.baselineY, run.metrics!.widthPt]));
            } else {
              reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
              const local = byFile[file]!.fallbacks;
              local[result.reason] = (local[result.reason] ?? 0) + 1;
            }
          }
        }
      } finally { await document.destroy(); }
    }
    expect(Object.keys(frozen)).toHaveLength(45);
    expect(lines).toBe(9315);
    expect(composed + Object.values(reasons).reduce((sum, count) => sum + count, 0)).toBe(lines);
    await writeFile('tmp/5d/composition-corpus123.json', JSON.stringify({ files: Object.keys(frozen).length, pages, lines, composed, reasons, byFile }, null, 2));
  }, 1_800_000);
});
