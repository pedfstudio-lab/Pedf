import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy, PDFDocumentProxy } from 'pdfjs-dist';
import { OPS } from 'pdfjs-dist';
import { extractTextRuns, groupRunsIntoBlocks, type TextBlock } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { detectBulletListFromRegions, availableBulletListHeight, formatBulletEditorText, type BulletList } from '@/lib/pdf/bulletList';
import { walkOperatorListGraphicsState, transformGraphicsPoint } from '@/lib/pdf/images';
import { screenRectToPdfRect } from '@/lib/export/coordinates';
import { exportPdf } from '@/lib/export/exportPdf';
import type { EditDocument, PdfRect } from '@/lib/export/types';
import { buildBulletListEdits, buildTextBlockEdits } from './buildTextEdits';
import { paragraphSeedText } from './paragraphSeed';

// Measurement only: expected defects are recorded, not treated as passing fixes.
const enabled = process.env.TASK76_MEASURE === '1' && existsSync('tmp/tables/baseline.json');
// Keep the reviewed pre-fix evidence immutable when this probe is rerun.
const historicalOutput = 'tmp/pdfs/task76-change0.json';
const output = 'tmp/pdfs/task76-current-measurement.json';
type PaintedPath = { rect: PdfRect; paintIndex: number; constructIndexes: number[]; subpaths: number; clipping: boolean; formDepth: number };
type PathAudit = { classification: 'own-path' | 'shared-path' | 'unknown'; paths: PaintedPath[] };
function inside(inner: PdfRect, outer: PdfRect, slack = 0.5) {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack
    && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
}
function pathAudit(rect: PdfRect, paths: PaintedPath[]): PathAudit {
  const matches = paths.filter(path => inside(rect, path.rect));
  const own = matches.filter(path => inside(path.rect, rect) && !path.clipping);
  return { classification: own.length === 1 ? 'own-path' : matches.length ? 'shared-path' : 'unknown', paths: own.length === 1 ? own : matches };
}
async function paintedPaths(page: PDFPageProxy, pageIndex: number): Promise<PaintedPath[]> {
  const viewport = page.getViewport({ scale: 1 }), list = await page.getOperatorList();
  const result: PaintedPath[] = [];
  let points: { x: number; y: number }[] = [], indexes: number[] = [], subpaths = 0, clipping = false, formDepth = 0;
  const clear = () => { points = []; indexes = []; subpaths = 0; clipping = false; };
  walkOperatorListGraphicsState(list, viewport, (op, args, matrix, index) => {
    if (op === OPS.paintFormXObjectBegin) formDepth += 1;
    if (op === OPS.paintFormXObjectEnd) formDepth -= 1;
    if (op === OPS.constructPath) {
      indexes.push(index);
      const operations = Array.from(args[0] as ArrayLike<number>), coords = Array.from(args[1] as ArrayLike<number>);
      let cursor = 0;
      const add = (x: number, y: number) => points.push(transformGraphicsPoint(matrix, x, y));
      for (const operation of operations) {
        if (operation === OPS.moveTo || operation === OPS.lineTo) {
          if (operation === OPS.moveTo) subpaths += 1;
          add(coords[cursor]!, coords[cursor + 1]!); cursor += 2;
        } else if (operation === OPS.rectangle) {
          const [x = 0, y = 0, w = 0, h = 0] = coords.slice(cursor, cursor + 4);
          add(x, y); add(x + w, y); add(x + w, y + h); add(x, y + h); cursor += 4; subpaths += 1;
        } else if (operation === OPS.curveTo || operation === OPS.curveTo2 || operation === OPS.curveTo3) {
          const count = operation === OPS.curveTo ? 6 : 4;
          for (let offset = 0; offset < count; offset += 2) add(coords[cursor + offset]!, coords[cursor + offset + 1]!);
          cursor += count;
        }
      }
    } else if (op === OPS.clip || op === OPS.eoClip) clipping = true;
    else if ([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(op)) {
      if (points.length) {
        const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
        const right = Math.max(...points.map(p => p.x)), bottom = Math.max(...points.map(p => p.y));
        result.push({ rect: screenRectToPdfRect({ left, top, width: right - left, height: bottom - top }, viewport, 1),
          paintIndex: index, constructIndexes: indexes, subpaths, clipping, formDepth });
      }
      clear();
    } else if ([OPS.stroke, OPS.closeStroke, OPS.endPath].includes(op)) clear();
  });
  void pageIndex;
  return result;
}
async function geometry(reader: PDFDocumentProxy): Promise<EditDocument['pages']> {
  return Promise.all(Array.from({ length: reader.numPages }, async (_, pageIndex) => {
    const page = await reader.getPage(pageIndex + 1), [left = 0, bottom = 0, right = 0, top = 0] = page.view;
    return { pageIndex, widthPt: right - left, heightPt: top - bottom, rotation: page.rotate as 0 | 90 | 180 | 270, boxOffset: { x: left, y: bottom } };
  }));
}
async function exportList(bytes: Uint8Array, reader: PDFDocumentProxy, pages: EditDocument['pages'], page: PDFPageProxy,
  list: BulletList, blocks: TextBlock[], addItem: boolean, artifact?: string) {
  const texts = list.items.map((item, index) => index === 0 ? item.text.replace(/\S/u, match => match.toLowerCase() === match ? match.toUpperCase() : match.toLowerCase()) : item.text);
  if (addItem) texts.push('New measurement item');
  // Preserve original display rows to isolate marker removal from font/reflow work.
  const items = texts.map((text, index) => ({ text, lines: index < list.items.length
    ? list.items[index]!.lines.map((line, lineIndex) => lineIndex === 0 && index === 0
      ? line.text.replace(/\S/u, match => match.toLowerCase() === match ? match.toUpperCase() : match.toLowerCase()) : line.text)
    : [text] }));
  const next = { text: formatBulletEditorText(texts), style: list.block.style, width: list.coverRect.w, height: list.coverRect.h, dx: 0, dy: 0 };
  const available = availableBulletListHeight(list, blocks, page.view[1] ?? 0);
  const built = buildBulletListEdits(list, next, items, 1, available);
  const oldProbeBuilt = buildBulletListEdits(list, next, items, 1, availableBulletListHeight(list, blocks, page.view[3] ?? 0));
  let patchCalls = 0;
  const exported = await exportPdf({ originalBytes: bytes, pages, edits: [...built.covers, ...built.texts],
    sampleBackground: () => { patchCalls += 1; return { r: 1, g: 1, b: 1 }; } }, { reader });
  if (artifact) await writeFile(artifact, exported.bytes);
  const after = await getDocument({ data: exported.bytes.slice(), verbosity: 0 }).promise;
  try {
    const exportedPage = await after.getPage(list.block.pageIndex + 1), content = await exportedPage.getTextContent();
    const dotGlyphs = content.items.reduce((count, item) => count + ('str' in item ? (item.str.match(/\u2022/g)?.length ?? 0) : 0), 0);
    const afterPaths = await paintedPaths(exportedPage, list.block.pageIndex);
    const beforePaths = await paintedPaths(page, list.block.pageIndex);
    const dotAudits = list.items.map(item => ({ kind: item.markerRun ? 'typed' : item.markerImage ? 'picture' : 'drawn', rect: item.markerRect,
      before: pathAudit(item.markerRect, beforePaths), after: pathAudit(item.markerRect, afterPaths) }));
    return { addItem, desiredItems: texts.length, availableHeightPt: available, usedHeightPt: built.usedHeightPt,
      overflow: built.overflow, builtCovers: built.covers.length, builtTexts: built.texts.length,
      originalProbeAvailableHeightPt: availableBulletListHeight(list, blocks, page.view[3] ?? 0), originalProbeOverflow: oldProbeBuilt.overflow,
      originalProbeBuiltEdits: oldProbeBuilt.covers.length + oldProbeBuilt.texts.length,
      redaction: exported.redaction, dotGlyphsOnPage: dotGlyphs, patchCalls, warnings: exported.warnings, dotAudits };
  } finally { await after.destroy(); }
}

describe.runIf(enabled)('Task 76 Change 0 - measurement, no fixes', () => {
  it('publishes all NMAT list outcomes, the historical bullet corpus and actual private-use codes', { timeout: 900_000 }, async () => {
    const baseline = JSON.parse(await readFile('tmp/tables/baseline.json', 'utf8')) as { files: Record<string, { pages: { pageIndex: number }[] }> };
    const corpus = [...Object.keys(baseline.files), 'tmp/nmat-check.pdf'];
    const files = [...corpus, 'tmp/green-check.pdf', 'tmp/grouping-probe/bullets-vector-test.pdf'];
    expect(files.every(file => existsSync(file)), 'All measured sources must exist').toBe(true);
    const perFile: { file: string; pages: number; documentPages: number; typed: number; picture: number; drawn: number; ownPath: number; sharedPath: number; unknown: number; lists: number }[] = [];
    const symbols: { file: string; page: number; code: string; sourceFont: string; fontRef: string; sourceText: string; lineText: string; x: number; y: number }[] = [];
    const drawnItems: { file: string; page: number; item: number; text: string; rect: PdfRect; audit: PathAudit }[] = [];
    const nmatLists: { page: number; list: number; text: string; items: { text: string; kind: string; rect: PdfRect; audit?: PathAudit }[]; edit: Awaited<ReturnType<typeof exportList>>; added: Awaited<ReturnType<typeof exportList>> }[] = [];
    const green: { page: number; text: string; detectedList: boolean; sourceCodes: string[]; outcome: string }[] = [];
    const report = { baseline: 'Task 76 current checkout; historical Change 0 evidence is retained separately', corpus, perFile, symbols, drawnItems, nmatLists, green, control: {} as object };
    for (const file of files) {
      const bytes = new Uint8Array(await readFile(file));
      const reader = await getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
      const counts = { file, pages: 0, documentPages: reader.numPages, typed: 0, picture: 0, drawn: 0, ownPath: 0, sharedPath: 0, unknown: 0, lists: 0 };
      try {
        const pages = file === 'tmp/nmat-check.pdf' || file === 'tmp/green-check.pdf' || file.includes('bullets-vector') ? await geometry(reader) : undefined;
        const indexes = baseline.files[file]?.pages.map(page => page.pageIndex) ?? Array.from({ length: reader.numPages }, (_, index) => index);
        for (const pageIndex of indexes) {
          counts.pages += 1;
          const page = await reader.getPage(pageIndex + 1);
          const [runs, rules, regions, paths, content] = await Promise.all([
            extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex), paintedPaths(page, pageIndex), page.getTextContent(),
          ]);
          const blocks = groupRunsIntoBlocks(runs, { ruleLines: rules, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
          for (const raw of content.items) {
            if (!('str' in raw) || !/^[\uF000-\uF0FF]/u.test(raw.str.trimStart())) continue;
            const x = raw.transform[4]!, y = raw.transform[5]!;
            const line = blocks.flatMap(block => block.lines).find(line => Math.abs(line.baselineY - y) <= 2 && Math.abs(line.rect.x - x) <= 1);
            if (!line) continue;
            const object = page.commonObjs.has(raw.fontName) ? page.commonObjs.get(raw.fontName) as { name?: string } : undefined;
            symbols.push({ file, page: pageIndex + 1, code: `U+${raw.str.trimStart().codePointAt(0)!.toString(16).toUpperCase()}`,
              sourceFont: object?.name ?? content.styles[raw.fontName]?.fontFamily ?? raw.fontName, fontRef: raw.fontName,
              sourceText: raw.str, lineText: line.text, x, y });
          }
          let listIndex = 0;
          for (const block of blocks) {
            const list = detectBulletListFromRegions(block, regions.imageRegions, regions.shapeMarkerRegions);
            if (list) {
              counts.lists += 1; listIndex += 1;
              const items = list.items.map((item, index) => {
                const kind = item.markerRun ? 'typed' : item.markerImage ? 'picture' : 'drawn'; counts[kind] += 1;
                if (kind !== 'drawn') return { text: item.text, kind, rect: item.markerRect };
                const audit = pathAudit(item.markerRect, paths);
                if (audit.classification === 'own-path') counts.ownPath += 1;
                else if (audit.classification === 'shared-path') counts.sharedPath += 1; else counts.unknown += 1;
                drawnItems.push({ file, page: pageIndex + 1, item: index + 1, text: item.text, rect: item.markerRect, audit });
                return { text: item.text, kind, rect: item.markerRect, audit };
              });
              if (file === 'tmp/nmat-check.pdf') {
                const artifact = pageIndex === 0 && listIndex === 1 ? 'tmp/pdfs/task76-nmat-current-export.pdf' : undefined;
                const edit = await exportList(bytes, reader, pages!, page, list, blocks, false, artifact);
                const added = await exportList(bytes, reader, pages!, page, list, blocks, true);
                nmatLists.push({ page: pageIndex + 1, list: listIndex, text: list.block.text, items, edit, added });
                process.stdout.write(`NMAT p${pageIndex + 1} list${listIndex}: ${items.length} items; edit removed=${edit.redaction.removedItems}, dots=${edit.dotGlyphsOnPage}, patch=${edit.patchCalls}; add overflow=${added.overflow}\n`);
              }
              if (file.includes('bullets-vector')) {
                report.control = await exportList(bytes, reader, pages!, page, list, blocks, true, 'tmp/pdfs/task76-vector-current-export.pdf');
              }
            }
            if (file === 'tmp/green-check.pdf' && /^[\uF000-\uF0FF]/u.test(block.text.trimStart())) {
              const text = `${paragraphSeedText(block)} edited`;
              const built = buildTextBlockEdits(block, { text, style: block.style, width: block.rect.w, height: block.rect.h, dx: 0, dy: 0 }, text.split('\n'), 1);
              let outcome = 'saved';
              try { await exportPdf({ originalBytes: bytes, pages: pages!, edits: [...built.covers, ...built.texts], sampleBackground: () => ({ r: 1, g: 1, b: 1 }) }, { reader }); }
              catch (error) { outcome = (error as Error).message; }
              green.push({ page: pageIndex + 1, text: block.text, detectedList: Boolean(list), sourceCodes: [...new Set([...block.text].filter(c => /^[\uF000-\uF0FF]$/u.test(c)).map(c => `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`))], outcome });
            }
          }
        }
      } finally { await reader.destroy(); }
      perFile.push(counts); await writeFile(output, JSON.stringify(report, null, 2));
      process.stdout.write(`FILE ${JSON.stringify(counts)}\n`);
    }
    const total = perFile.filter(row => corpus.includes(row.file)).reduce((sum, row) => ({ typed: sum.typed + row.typed, picture: sum.picture + row.picture,
      drawn: sum.drawn + row.drawn, ownPath: sum.ownPath + row.ownPath, sharedPath: sum.sharedPath + row.sharedPath, unknown: sum.unknown + row.unknown }),
    { typed: 0, picture: 0, drawn: 0, ownPath: 0, sharedPath: 0, unknown: 0 });
    process.stdout.write(`HISTORICAL CORPUS ${JSON.stringify(total)}\nSYMBOLS ${JSON.stringify(symbols.map(s => ({ file: s.file, page: s.page, code: s.code, font: s.sourceFont })))}\nGREEN ${JSON.stringify(green.map(g => ({ page: g.page, list: g.detectedList, outcome: g.outcome })))}\n`);
    expect(total.drawn).toBe(total.ownPath + total.sharedPath + total.unknown);
    expect(nmatLists.length).toBeGreaterThan(0);
    expect(green.length).toBeGreaterThan(0);
    // Baseline counts are reported for review, not silently re-frozen here.
  });
});

describe.runIf(process.env.TASK76_FONT_COMPARE === '1' && existsSync(historicalOutput))('Task 76 historical typed-count comparison', () => {
  it('names any detection difference caused by the old probe omitting production font metadata', { timeout: 300_000 }, async () => {
    const measured = JSON.parse(await readFile(historicalOutput, 'utf8')) as { symbols: { file: string; page: number }[] };
    const file = 'tmp/text-doubling/corporate-edited-3.pdf';
    const pageNumbers = [...new Set(measured.symbols.filter(symbol => symbol.file === file).map(symbol => symbol.page))];
    const rows: { page: number; oldItems: string[]; productionItems: string[]; orphanMarkers: string[] }[] = [];
    const bytes = new Uint8Array(await readFile(file));
    const oldReader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    const currentReader = await getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
    const inspect = async (reader: PDFDocumentProxy, pageNumber: number) => {
      const page = await reader.getPage(pageNumber), pageIndex = pageNumber - 1;
      const [runs, rules, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
      const blocks = groupRunsIntoBlocks(runs, { ruleLines: rules, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
      const lists = blocks.map(block => detectBulletListFromRegions(block, regions.imageRegions, regions.shapeMarkerRegions)).filter(list => list !== null);
      const typedItems = lists.flatMap(list => list.items.filter(item => item.markerRun));
      return { items: typedItems.map(item => item.text), orphans: blocks.flatMap(block => block.lines)
        .filter(line => line.text.trimStart().startsWith('•') && !typedItems.some(item => item.markerRun?.rect.y === line.runs[0]?.rect.y && item.markerRun?.rect.x === line.runs[0]?.rect.x)).map(line => line.text) };
    };
    try {
      for (const page of pageNumbers) {
        const old = await inspect(oldReader, page), current = await inspect(currentReader, page);
        rows.push({ page, oldItems: old.items, productionItems: current.items, orphanMarkers: current.orphans });
      }
    } finally { await oldReader.destroy(); await currentReader.destroy(); }
    await writeFile('tmp/pdfs/task76-font-metadata-comparison.json', JSON.stringify(rows, null, 2));
    process.stdout.write(JSON.stringify(rows.filter(row => JSON.stringify(row.oldItems) !== JSON.stringify(row.productionItems) || row.orphanMarkers.length), null, 2) + '\n');
    expect(rows.length).toBeGreaterThan(0);
  });
});
