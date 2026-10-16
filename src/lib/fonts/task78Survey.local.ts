// Local diagnostic only: application code must not import this measurement harness.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OPS, type PDFPageProxy } from 'pdfjs-dist';
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts, type PDFFont } from 'pdf-lib';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { extractTextRuns, groupRunsIntoBlocks, mergeRunsIntoLines, type TextBlock, type TextLine } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { detectBulletListFromRegions } from '@/lib/pdf/bulletList';
import { measureTextWithPageFont, registerPdfJsFontReference, resolvePageFontResource } from '@/lib/export/embeddedFont';
import { resolveEnglishFont } from '@/lib/export/englishFont';
import { matchFont } from './fontMatch';
import { makePageContext, type PageExportContext } from '@/lib/export/context';
import { isIndicRun } from '@/lib/export/scriptRouting';
import type { TextSpan, TextStyle } from '@/lib/export/types';
import { effectiveTextSpanStyle, sourceSpansForTextBlock } from '@/lib/edit/richText';
import { sourceParagraphs } from '@/lib/edit/paragraphSeed';
import { textStyleToCanvasFont } from '@/lib/edit/textStyleCss';
import { wrapTextParagraphs } from '@/lib/edit/paragraphLayout';

const OUTPUT = process.env.TASK78_OUTPUT ?? 'tmp/task78';
const WORD = 'extra';
const directory = fileURLToPath(new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));
const standardFontDataUrl = directory.endsWith(sep) ? directory : directory + sep;
const stripSubset = (name: string) => name.replace(/^[A-Z]{6}\+/, '');
const identity = (name: string) => name.trim().replace(/^\//, '').toLowerCase();
const family = (name: string) => stripSubset(name).replace(/(?:PSMT|MT)$/i, '')
  .replace(/(?:[-_, ](?:bolditalic|boldoblique|semibold|demibold|regular|italic|oblique|bold|heavy|medium|light|bdit))+$/ig, '')
  .replace(/PS$/i, '').replace(/^Times-Roman$/i, 'Times').replace(/^TimesNewRoman$/i, 'Times New Roman');
const rounded = (value: number) => Number(value.toFixed(6));
const cell = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
// Paragraph separators are layout, not characters passed to a PDF font encoder.
const encodingText = (text: string) => text.replaceAll('\n', '');

interface FontObject {
  name: string; type: string; isType3Font?: boolean; missingFile?: boolean; vertical?: boolean;
  fontMatrix?: number[]; data?: Uint8Array; widths?: Record<string, number>; defaultWidth?: number;
  toUnicode?: { _map?: Record<string, string> }; defaultEncoding?: string[]; differences?: Record<string, string>;
}
interface RawFont { name: string; aliases: string[]; type: string; embedded: string; encoding: string }
interface FontUse {
  object: FontObject; raw: RawFont; widths: Map<string, number>; ambiguous: Set<string>;
  observed: Set<string>; textWidths: Map<string, number>; matchKeys?: string[];
  draws: number; inventoryKey: string; browserRegistered: boolean; family: string;
}
interface Inventory {
  name: string; family: string; type: string; embedded: string; encoding: string; reuseGate: string;
  reasons: string[]; files: Set<string>; pages: Set<string>; drawnCharacters: number;
  eligiblePieces: number; checkedPieces: number; screenRegistrations: number;
}
interface WidthSample {
  file: string; page: number; family: string; font: string; text: string;
  originalPt: number; fallbackPt: number; deltaPercent: number; fallback: string; reuse: boolean;
}
interface ParagraphSample {
  file: string; page: number; block: number; paragraph: number; family: string; families: string[];
  kind: string; text: string; widthPt: number; sourceLines: number;
  canvasBefore?: number; canvasAfter?: number; exportBefore?: number; exportAfter?: number;
  fallbackBefore?: number; fallbackAfter?: number; sourceControlBefore?: number; sourceControlAfter?: number;
  unmeasured?: string;
}
interface FileResult { file: string; sha256: string; bytes: number; pages: number; usedFonts: number; lines: number; paragraphs: number }
interface SurveyData {
  files: string[]; supplemental: string[]; inventory: Map<string, Inventory>; widths: WidthSample[];
  paragraphs: ParagraphSample[]; results: FileResult[]; unavailableWidths: Record<string, number>; unassociatedFonts: string[];
}

function fontName(dict: PDFDict): string {
  const descriptor = dict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  return (dict.lookupMaybe(PDFName.of('BaseFont'), PDFName) ?? descriptor?.lookupMaybe(PDFName.of('FontName'), PDFName)
    ?? dict.lookupMaybe(PDFName.of('Name'), PDFName))?.decodeText() ?? '(unnamed)';
}
function rawFont(dict: PDFDict): RawFont {
  const type = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? 'Unknown';
  const descendant = dict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict);
  const descriptor = (descendant ?? dict).lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  const embedded = type === 'Type3' ? (dict.get(PDFName.of('CharProcs')) ? 'yes (CharProcs)' : 'no')
    : ['FontFile', 'FontFile2', 'FontFile3'].some(key => descriptor?.get(PDFName.of(key))) ? 'yes' : 'no';
  const encoding = dict.lookup(PDFName.of('Encoding'));
  let description = encoding instanceof PDFName ? encoding.decodeText() : 'absent (font default)';
  if (encoding instanceof PDFDict) {
    const base = encoding.lookupMaybe(PDFName.of('BaseEncoding'), PDFName)?.decodeText() ?? 'custom';
    description = encoding.lookupMaybe(PDFName.of('Differences'), PDFArray) ? `${base} + Differences` : base;
  } else if (encoding && !(encoding instanceof PDFName)) description = 'embedded CMap';
  const aliases = [...new Set([fontName(dict), descriptor?.lookupMaybe(PDFName.of('FontName'), PDFName)?.decodeText()].filter((value): value is string => Boolean(value)))];
  return { name: fontName(dict), aliases, type, embedded, encoding: description };
}
function collectRawFonts(pdf: PDFDocument): RawFont[] {
  const found: RawFont[] = [], visited = new Set<PDFDict>();
  const visit = (dict: PDFDict) => {
    if (visited.has(dict)) return;
    visited.add(dict);
    if (dict.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText() === 'Font') found.push(rawFont(dict));
    for (const [, value] of dict.entries()) {
      const resolved = pdf.context.lookup(value);
      if (resolved instanceof PDFDict) visit(resolved);
      else if (resolved instanceof PDFArray) for (let i = 0; i < resolved.size(); i++) {
        const child = resolved.lookup(i); if (child instanceof PDFDict) visit(child);
      }
    }
  };
  for (const [, value] of pdf.context.enumerateIndirectObjects()) if (value instanceof PDFDict) visit(value);
  return found;
}
function matchRaw(font: FontObject, all: readonly RawFont[]): RawFont {
  const expected = font.type.startsWith('CIDFont') ? 'Type0' : font.isType3Font ? 'Type3' : font.type.startsWith('Type1') ? 'Type1' : font.type;
  const names = all.filter(raw => raw.aliases.some(name => identity(name) === identity(font.name)));
  const typed = names.filter(raw => raw.type === expected);
  const matches = typed.length ? typed : names.filter(raw => !raw.type.startsWith('CIDFont'));
  const variants = [...new Map(matches.map(raw => [JSON.stringify([raw.type, raw.embedded, raw.encoding]), raw])).values()];
  if (variants.length === 1) return variants[0]!;
  // Do not infer raw embedding/encoding from pdf.js's converted browser font.
  return { name: font.name, aliases: [font.name], type: expected, embedded: 'unresolved', encoding: variants.length ? 'ambiguous resource match' : 'unresolved resource match' };
}
function addWidth(use: FontUse, text: string, em: number, observed = false) {
  if (!text || !Number.isFinite(em) || em < 0) return;
  if (observed && !use.observed.has(text)) {
    use.observed.add(text); use.ambiguous.delete(text); use.widths.set(text, em); return;
  }
  if (!observed && (em === 0 || use.observed.has(text))) return;
  const old = use.widths.get(text);
  if (old !== undefined && Math.abs(old - em) > 0.000001) use.ambiguous.add(text);
  else use.widths.set(text, em);
}
function sourceWidth(text: string, style: TextStyle, uses: ReadonlyMap<string, FontUse>): number {
  const use = style.fontRef ? uses.get(style.fontRef) : undefined;
  if (!use || use.object.vertical) return NaN;
  const cached = use.textWidths.get(text); if (cached !== undefined) return cached * style.fontSizePt;
  const keys = use.matchKeys ??= [...use.widths.keys()].filter(key => !use.ambiguous.has(key)).sort((a, b) => b.length - a.length);
  let width = 0, cursor = 0;
  while (cursor < text.length) {
    const key = keys.find(value => text.startsWith(value, cursor));
    if (!key) return NaN;
    width += use.widths.get(key)!; cursor += key.length;
  }
  use.textWidths.set(text, width); return width * style.fontSizePt;
}

function programFamily(data?: Uint8Array): string | undefined {
  if (!data || data.length < 12) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records = view.getUint16(4); let table = 0;
  for (let i = 0; i < records && 12 + i * 16 + 16 <= data.length; i++) {
    const offset = 12 + i * 16;
    if (String.fromCharCode(...data.slice(offset, offset + 4)) === 'name') table = view.getUint32(offset + 8);
  }
  if (!table || table + 6 > data.length) return undefined;
  const count = view.getUint16(table + 2), strings = table + view.getUint16(table + 4);
  const found: { value: string; rank: number }[] = [];
  for (let i = 0; i < count && table + 6 + i * 12 + 12 <= data.length; i++) {
    const offset = table + 6 + i * 12, platform = view.getUint16(offset), id = view.getUint16(offset + 6);
    if (![1, 16].includes(id)) continue;
    const length = view.getUint16(offset + 8), start = strings + view.getUint16(offset + 10);
    if (start + length > data.length) continue;
    let value = '';
    if (platform === 0 || platform === 3) for (let j = 0; j + 1 < length; j += 2) value += String.fromCharCode(view.getUint16(start + j));
    else if (platform === 1) value = String.fromCharCode(...data.slice(start, start + length));
    if (value && !/^g_d\d+_f\d+$/i.test(value)) found.push({ value, rank: (id === 16 ? 10 : 0) + (platform === 3 ? 1 : 0) });
  }
  return found.sort((a, b) => b.rank - a.rank)[0]?.value;
}
function reuseStyle(style: TextStyle): TextStyle {
  return style.sourceBold === true && !style.bold ? { ...style, fontRef: undefined } : style;
}
function reuseReason(use: FontUse, context: PageExportContext, ref: string): string[] {
  const style: TextStyle = { fontRef: ref, fontName: use.object.name, fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
  if (resolvePageFontResource(context, style)) return [];
  const reasons: string[] = [];
  if (!['TrueType', 'Type1'].includes(use.object.type) || use.object.isType3Font) reasons.push(`${use.object.type} not accepted`);
  if (use.object.missingFile) reasons.push('pdf.js missingFile');
  if (use.raw.embedded === 'no') reasons.push('not embedded');
  if (!use.raw.encoding.startsWith('WinAnsiEncoding')) reasons.push('not explicit WinAnsi');
  if (!reasons.length) reasons.push('no supported matching font in page resources (e.g. form-only)');
  return reasons;
}
async function pageFontUses(page: PDFPageProxy, raw: readonly RawFont[]): Promise<Map<string, FontUse>> {
  const list = await page.getOperatorList(), uses = new Map<string, FontUse>();
  let state = { ref: '', mode: 0 }; const stack: typeof state[] = [];
  for (const [index, op] of list.fnArray.entries()) {
    const args = list.argsArray[index] as unknown[];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ ...state });
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) state = stack.pop() ?? state;
    else if (op === OPS.setFont) state.ref = String(args[0]);
    else if (op === OPS.setTextRenderingMode) state.mode = Number(args[0]);
    if (![OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText].includes(op) || state.mode === 3 || state.mode === 7 || !state.ref) continue;
    const font = page.commonObjs.get(state.ref) as FontObject;
    let use = uses.get(state.ref);
    if (!use) {
      const metadata = matchRaw(font, raw);
      const browserRegistered = font.data ? Boolean(GlobalFonts.register(Buffer.from(font.data), state.ref)) : false;
      const measuredFamily = /^CIDFont\+/i.test(font.name) ? programFamily(font.data) ?? font.name : font.name;
      use = { object: font, raw: metadata, widths: new Map(), ambiguous: new Set(), observed: new Set(), textWidths: new Map(),
        draws: 0, inventoryKey: '', browserRegistered, family: family(measuredFamily) };
      uses.set(state.ref, use); registerPdfJsFontReference(state.ref, font);
      const factor = font.isType3Font ? Math.abs(font.fontMatrix?.[0] ?? NaN) : 0.001;
      for (const [code, unicode] of Object.entries(font.toUnicode?._map ?? {})) {
        const width = font.widths?.[code] ?? font.defaultWidth;
        if (typeof unicode === 'string' && width !== undefined) addWidth(use, unicode, width * factor);
      }
      const encoding: Record<string, string> = { ...font.differences };
      font.defaultEncoding?.forEach((name, code) => { if (encoding[String(code)] === undefined) encoding[String(code)] = name; });
      for (const [code, name] of Object.entries(encoding)) {
        if (name === 'space') { const width = font.widths?.[code] ?? font.defaultWidth; if (width !== undefined) addWidth(use, ' ', width * factor); }
      }
    }
    const active = use;
    const collect = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (!value || typeof value !== 'object') return;
      const glyph = value as { unicode?: string; width?: number };
      if (typeof glyph.unicode !== 'string' || typeof glyph.width !== 'number') return;
      addWidth(active, glyph.unicode, glyph.width * (font.isType3Font ? Math.abs(font.fontMatrix?.[0] ?? NaN) : 0.001), true);
      active.draws += [...glyph.unicode].length;
    };
    collect(op === OPS.nextLineSetSpacingShowText ? args.at(-1) : args[0]);
  }
  return uses;
}
function subBlock(block: TextBlock, lines: readonly TextLine[], width: number): TextBlock {
  return { ...block, text: lines.map(line => line.text).join('\n'), lines, rect: { ...block.rect, w: width } };
}
function paragraphGroupText(groups: { text: string; lines: readonly unknown[] }, index: number, fallback: string): string {
  return groups.lines.length === 1 ? groups.text : groups.text.split('\n')[index] ?? fallback;
}
function widthStats(samples: readonly WidthSample[]) {
  if (!samples.length) return { lines: 0, meanPercent: null, worstNarrowerPercent: null, worstWiderPercent: null };
  return { lines: samples.length, meanPercent: rounded(samples.reduce((sum, row) => sum + row.deltaPercent, 0) / samples.length),
    worstNarrowerPercent: rounded(Math.min(0, ...samples.map(row => row.deltaPercent))), worstWiderPercent: rounded(Math.max(0, ...samples.map(row => row.deltaPercent))) };
}
function paragraphStats(rows: readonly ParagraphSample[]) {
  const valid = rows.filter(row => !row.unmeasured);
  return { total: rows.length, measured: valid.length, unmeasured: rows.length - valid.length,
    canvasAlreadyGrows: valid.filter(row => row.canvasBefore! > row.sourceLines).length,
    canvasEditedGrows: valid.filter(row => row.canvasAfter! > row.sourceLines).length,
    canvasExtraWordAddsLine: valid.filter(row => row.canvasAfter! > row.canvasBefore!).length,
    exportEditedGrows: valid.filter(row => row.exportAfter! > row.sourceLines).length,
    fallbackEditedGrows: valid.filter(row => row.fallbackAfter! > row.sourceLines).length,
    sourceControlMeasured: valid.filter(row => row.sourceControlAfter !== undefined).length,
    sourceControlEditedGrows: valid.filter(row => row.sourceControlAfter !== undefined && row.sourceControlAfter > row.sourceLines).length };
}

export async function verifySurveyAssumptions() {
  expect(family('ABCDEF+Times New Roman')).toBe('Times New Roman');
  expect(family('ABCDEF+TimesNewRomanPSMT')).toBe('Times New Roman');
  expect(family('ABCDEF+Arial-BoldMT')).toBe('Arial');
  expect(family('ABCDEF+Arial Black')).toBe('Arial Black');
  expect(family('ABCDEF+HelveticaNowText-BdIt')).toBe('HelveticaNowText');
  const raw: RawFont = { name: 'Helvetica', aliases: ['Helvetica'], type: 'Type1', embedded: 'no', encoding: 'WinAnsiEncoding' };
  const object: FontObject = { name: 'Helvetica', type: 'TrueType' };
  expect(matchRaw(object, [raw]).type).toBe('Type1');
  const use: FontUse = { object, raw, widths: new Map(), ambiguous: new Set(), observed: new Set(), textWidths: new Map(), draws: 0, inventoryKey: '', browserRegistered: false, family: 'Helvetica' };
  addWidth(use, ' ', 0.25); addWidth(use, ' ', 0);
  expect(use.ambiguous.has(' ')).toBe(false);
  addWidth(use, 'x', 0.5); addWidth(use, 'x', 0.7);
  expect(use.ambiguous.has('x')).toBe(true);
  addWidth(use, 'x', 0.6, true);
  expect(use.ambiguous.has('x')).toBe(false);
  const style: TextStyle = { fontRef: 'test', fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
  expect(sourceWidth('x ', style, new Map([['test', use]]))).toBeCloseTo(8.5);
  expect(sourceWidth('z', style, new Map([['test', use]]))).toBeNaN();
  expect(programFamily(new Uint8Array(3))).toBeUndefined();
  expect(paragraphGroupText({ text: 'Title\nSubtitle', lines: [[]] }, 0, '')).toBe('Title\nSubtitle');
  expect(paragraphGroupText({ text: 'First paragraph\nSecond paragraph', lines: [[], []] }, 1, '')).toBe('Second paragraph');
  const font = (await PDFDocument.create()).embedStandardFont(StandardFonts.Helvetica);
  expect(() => font.encodeText(encodingText('Title\nSubtitle'))).not.toThrow();
  expect(() => font.encodeText(encodingText('Title\n\u2603'))).toThrow();
}

/** Reformat/reaggregate recorded observations; never reruns or alters their width/line measurements. */
export async function publishMeasuredSurvey() {
  const saved = JSON.parse(await readFile(`${OUTPUT}/font-survey.json`, 'utf8')) as {
    manifest: string[]; supplemental: string[]; fonts: (Omit<Inventory, 'files' | 'pages'> & { files: string[]; pages: string[] })[];
    files: FileResult[]; widths: WidthSample[]; paragraphs: ParagraphSample[]; unassociatedFonts: string[];
    totals: { unavailableWidths: Record<string, number> };
  };
  const canonical = (value: string) => value === 'TimesNewRoman' ? 'Times New Roman' : value;
  const inventory = new Map(saved.fonts.map((row, index) => [String(index), { ...row, family: canonical(row.family), files: new Set(row.files), pages: new Set(row.pages) }]));
  saved.widths.forEach(row => { row.family = canonical(row.family); });
  saved.paragraphs.forEach(row => { row.family = canonical(row.family); row.families = [...new Set(row.families.map(canonical))]; });
  await publishSurvey({ files: saved.manifest, supplemental: saved.supplemental, inventory, widths: saved.widths, paragraphs: saved.paragraphs,
    results: saved.files, unavailableWidths: saved.totals.unavailableWidths, unassociatedFonts: saved.unassociatedFonts });
}

export async function probeFonts() {
  for (const file of ['tmp/compress-tests/cv-signed.pdf', 'tmp/pdfs/task52-merge-qa/form-1.pdf', 'tmp/tables/Firgun_QT-H4SNASRX_SriLanka.pdf', 'tmp/paragraphs/Corporate-Governance-edited (25).pdf', 'tmp/compress-tests/ladakh-original.pdf']) {
    const bytes = new Uint8Array(await readFile(file));
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const reader = await getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true, standardFontDataUrl }).promise;
    try {
      const page = await reader.getPage(Math.min(2, reader.numPages)), uses = await pageFontUses(page, collectRawFonts(pdf));
      process.stdout.write(JSON.stringify({ file, fonts: [...uses].slice(0, 8).map(([ref, use]) => ({
        ref, name: use.object.name, family: use.family, type: use.object.type, raw: use.raw,
        widthSample: [...use.widths].slice(0, 3), space: use.widths.get(' '), ambiguous: [...use.ambiguous],
      })), descriptors: pdf.context.enumerateIndirectObjects().flatMap(([, dict]) => dict instanceof PDFDict && dict.get(PDFName.of('FontName')) ? [{ name: dict.get(PDFName.of('FontName'))?.toString(), family: dict.get(PDFName.of('FontFamily'))?.toString() }] : []).slice(0, 12) }) + '\n');
    } finally { await reader.destroy(); }
  }
}

export async function surveyFonts() {
  const frozen = JSON.parse(await readFile('tmp/5d/source-text-before.json', 'utf8')) as Record<string, unknown>;
  // Identical manifest to the accepted Step 5d SQUEEZE_SCOPE survey.
  const files = [...Object.keys(frozen), "tmp/paragraphs/Bhutan December'26.pdf", 'tmp/paragraphs/Corporate-Governance-edited (25).pdf'];
  expect(files).toHaveLength(47); expect(new Set(files).size).toBe(47);
  const supplemental = ['tmp/green-check.pdf', 'tmp/nmat-check.pdf'];
  const inventory = new Map<string, Inventory>(), widths: WidthSample[] = [], paragraphs: ParagraphSample[] = [], results: FileResult[] = [];
  const unavailableWidths: Record<string, number> = {}, unassociatedFonts: string[] = [];
  const context2d = createCanvas(1, 1).getContext('2d');
  await mkdir(OUTPUT, { recursive: true });
  for (const [fileIndex, file] of [...files, ...supplemental].entries()) {
    const bytes = new Uint8Array(await readFile(file));
    const reader = await getDocument({ data: bytes.slice(), fontExtraProperties: true, standardFontDataUrl, verbosity: 0 }).promise;
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const raw = collectRawFonts(pdf), startingParagraphs = paragraphs.length;
    let lineCount = 0; const usedKeys = new Set<string>();
    try {
      for (let pageIndex = 0; pageIndex < reader.numPages; pageIndex++) {
        const page = await reader.getPage(pageIndex + 1), uses = await pageFontUses(page, raw);
        const [runs, rules, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
        const geometry = { pageIndex, widthPt: page.view[2]! - page.view[0]!, heightPt: page.view[3]! - page.view[1]!, rotation: 0 as const, boxOffset: { x: page.view[0]!, y: page.view[1]! } };
        const context = makePageContext({ pdf, page: pdf.getPage(pageIndex), geometry, doc: { originalBytes: bytes, pages: [geometry], edits: [] }, warnings: [] });
        for (const [ref, use] of uses) {
          const reasons = reuseReason(use, context, ref);
          const key = JSON.stringify([fileIndex < files.length ? 'core' : 'supplemental', stripSubset(use.object.name), use.family, use.raw.type, use.raw.embedded, use.raw.encoding, reasons.length === 0]);
          use.inventoryKey = key; usedKeys.add(key);
          const row = inventory.get(key) ?? { name: stripSubset(use.object.name), family: use.family, type: use.raw.type,
            embedded: use.raw.embedded, encoding: use.raw.encoding, reuseGate: reasons.length ? 'no' : 'yes (text coverage still required)', reasons: [],
            files: new Set<string>(), pages: new Set<string>(), drawnCharacters: 0, eligiblePieces: 0, checkedPieces: 0, screenRegistrations: 0 };
          row.files.add(file); row.pages.add(`${file}:${pageIndex + 1}`); row.drawnCharacters += use.draws;
          row.reasons = [...new Set([...row.reasons, ...reasons])]; row.screenRegistrations += Number(use.browserRegistered);
          inventory.set(key, row);
          if (use.raw.embedded === 'unresolved') unassociatedFonts.push(`${file} p${pageIndex + 1} ${use.object.name} ${use.object.type}`);
        }
        const standard = new Map<string, PDFFont>();
        const fallbackFont = async (style: TextStyle) => {
          const key = JSON.stringify([style.fontName, style.bold, style.italic]);
          if (!standard.has(key)) standard.set(key, await resolveEnglishFont(style, context));
          return standard.get(key)!;
        };
        const lines = mergeRunsIntoLines(runs, { ruleLines: rules, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
        lineCount += lines.length;
        for (const line of lines) {
          const byFamily = new Map<string, (typeof line.runs)[number][]>();
          for (const run of line.runs) {
            const use = run.style.fontRef ? uses.get(run.style.fontRef) : undefined;
            if (!use) continue;
            const key = use.family, values = byFamily.get(key) ?? []; values.push(run); byFamily.set(key, values);
            const row = inventory.get(use.inventoryKey)!; row.checkedPieces++;
            row.eligiblePieces += Number(measureTextWithPageFont(run.text, reuseStyle(run.style), context) !== null);
          }
          for (const [fontFamily, parts] of byFamily) {
            let original = 0, fallback = 0, reason = ''; const fallbacks = new Set<string>();
            for (const run of parts) {
              const width = sourceWidth(run.text, run.style, uses);
              if (!Number.isFinite(width) || width <= 0) { reason = 'missing/ambiguous source Unicode advances or vertical text'; break; }
              if (isIndicRun(run.text)) { reason = 'Indic export route out of scope'; break; }
              const font = await fallbackFont(run.style);
              try { fallback += [...run.text].reduce((sum, character) => sum + font.widthOfTextAtSize(character, run.style.fontSizePt), 0); }
              catch { reason = 'standard fallback cannot encode entire line contribution'; break; }
              original += width; fallbacks.add(font.name);
            }
            if (reason) { if (fileIndex < files.length) unavailableWidths[reason] = (unavailableWidths[reason] ?? 0) + 1; continue; }
            if (original <= 0) continue;
            widths.push({ file, page: pageIndex + 1, family: fontFamily,
              font: [...new Set(parts.map(run => stripSubset(uses.get(run.style.fontRef!)!.object.name)))].join(' + '),
              text: parts.map(run => run.text).join(''), originalPt: rounded(original), fallbackPt: rounded(fallback), deltaPercent: rounded((fallback / original - 1) * 100),
              fallback: [...fallbacks].join(' + '), reuse: parts.every(run => measureTextWithPageFont(run.text, reuseStyle(run.style), context) !== null) });
          }
        }
        const blocks = groupRunsIntoBlocks(runs, { ruleLines: rules, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
        for (const [blockIndex, block] of blocks.entries()) {
          const list = detectBulletListFromRegions(block, regions.imageRegions, regions.shapeMarkerRegions);
          const sources = list ? list.items.map(item => ({ value: subBlock(list.block, item.lines, list.block.rect.w), kind: 'list item' }))
            : [{ value: block, kind: block.lines.length > 1 ? 'multiline block' : 'one-line block (includes headings/cells)' }];
          for (const { value, kind } of sources) {
            const groups = sourceParagraphs(value);
            for (const [paragraphIndex, originalLines] of groups.lines.entries()) {
              if (!originalLines.length) continue;
              const paragraph = subBlock(value, originalLines, value.rect.w);
              // Centre/right blocks are one source group with intentional newlines.
              // Do not truncate that group to its first displayed line.
              const text = paragraphGroupText(groups, paragraphIndex, paragraph.text.replaceAll('\n', ' '));
              const families = [...new Set(originalLines.flatMap(line => line.runs.map(run => uses.get(run.style.fontRef ?? '')).filter((use): use is FontUse => Boolean(use)).map(use => use.family)))];
              const row: ParagraphSample = { file, page: pageIndex + 1, block: blockIndex, paragraph: paragraphIndex,
                family: families.length === 1 ? families[0]! : '(mixed families)', families, kind, text,
                widthPt: rounded(value.rect.w), sourceLines: originalLines.length };
              paragraphs.push(row);
              const spans = sourceSpansForTextBlock(paragraph, text, true);
              if (!spans?.length || !text.trim() || !families.length) { row.unmeasured = 'source spans/identity unavailable'; continue; }
              if (isIndicRun(text)) { row.unmeasured = 'Indic export route out of scope'; continue; }
              const changed = [...spans, { ...spans.at(-1)!, text: ` ${WORD}` }];
              const styleKeys = new Map<string, PDFFont>();
              // Wrapping rebuilds spans; optional field ordering is not a font
              // identity. Key by the selected binary, not serialized objects.
              for (const span of changed) { const style = effectiveTextSpanStyle(value.style, span); styleKeys.set(matchFont(style).file, await fallbackFont(style)); }
              const fontFor = (span: TextSpan) => styleKeys.get(matchFont(effectiveTextSpanStyle(value.style, span)).file)!;
              try { changed.forEach(span => fontFor(span).encodeText(encodingText(span.text))); }
              catch { row.unmeasured = 'fallback cannot encode full paragraph; skipped characters are not zero-width text'; continue; }
              const layout = groups.layouts[paragraphIndex] ?? { firstIndentPt: 0, restIndentPt: 0, gapBeforePt: 0 };
              const wrap = (values: readonly TextSpan[], measure: (text: string, span: TextSpan) => number) => wrapTextParagraphs({
                text: values.map(span => span.text).join(''), spans: values, style: value.style, width: value.rect.w,
                height: value.rect.h, dx: 0, dy: 0, align: value.align, paragraphs: [layout],
              }, measure).length;
              const canvasMeasure = (str: string, span: TextSpan) => {
                const style = effectiveTextSpanStyle(value.style, span); context2d.font = textStyleToCanvasFont(style); return context2d.measureText(str).width;
              };
              const fallbackMeasure = (str: string, span: TextSpan) => fontFor(span).widthOfTextAtSize(str, effectiveTextSpanStyle(value.style, span).fontSizePt);
              const exportMeasure = (str: string, span: TextSpan) => measureTextWithPageFont(str, reuseStyle(effectiveTextSpanStyle(value.style, span)), context) ?? fallbackMeasure(str, span);
              row.canvasBefore = wrap(spans, canvasMeasure); row.canvasAfter = wrap(changed, canvasMeasure);
              row.exportBefore = wrap(spans, exportMeasure); row.exportAfter = wrap(changed, exportMeasure);
              row.fallbackBefore = wrap(spans, fallbackMeasure); row.fallbackAfter = wrap(changed, fallbackMeasure);
              const sourceMeasure = (str: string, span: TextSpan) => sourceWidth(str, effectiveTextSpanStyle(value.style, span), uses);
              if (changed.every(span => Number.isFinite(sourceMeasure(span.text.replaceAll('\n', ''), span)))) {
                row.sourceControlBefore = wrap(spans, sourceMeasure); row.sourceControlAfter = wrap(changed, sourceMeasure);
              }
            }
          }
        }
        page.cleanup();
      }
      results.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, pages: reader.numPages,
        usedFonts: usedKeys.size, lines: lineCount, paragraphs: paragraphs.length - startingParagraphs });
    } finally { await reader.destroy(); }
    await writeFile(`${OUTPUT}/progress.json`, JSON.stringify({ completed: results, total: files.length, supplemental: supplemental.length }, null, 2));
    process.stdout.write(`TASK78 ${fileIndex + 1}/${files.length + supplemental.length} ${file}: ${lineCount} lines, ${paragraphs.length - startingParagraphs} paragraphs\n`);
  }
  await publishSurvey({ files, supplemental, inventory, widths, paragraphs, results, unavailableWidths, unassociatedFonts });
}

async function publishSurvey({ files, supplemental, inventory, widths, paragraphs, results, unavailableWidths, unassociatedFonts }: SurveyData) {
  const core = new Set(files), coreWidths = widths.filter(row => core.has(row.file)), coreParagraphs = paragraphs.filter(row => core.has(row.file));
  const families = [...new Set([...inventory.values()].filter(row => [...row.files].some(file => core.has(file))).map(row => row.family))].sort();
  const familyRows = families.map(name => ({ family: name, fallback: [...new Set(coreWidths.filter(row => row.family === name).map(row => row.fallback))].join(', '),
    allLines: widthStats(coreWidths.filter(row => row.family === name)), fallbackRequired: widthStats(coreWidths.filter(row => row.family === name && !row.reuse)),
    paragraphs: paragraphStats(coreParagraphs.filter(row => row.family === name)) }));
  const fontRows = [...inventory.values()].map(row => ({ ...row, files: [...row.files].sort(), pages: [...row.pages].sort() })).sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  const report = { version: 1, measuredOn: '2026-10-15', word: WORD, manifest: files, supplemental,
    totals: { files: files.length, pages: results.filter(row => core.has(row.file)).reduce((sum, row) => sum + row.pages, 0),
      lines: results.filter(row => core.has(row.file)).reduce((sum, row) => sum + row.lines, 0),
      usedFontVariants: fontRows.filter(row => row.files.some(file => core.has(file))).length, families: families.length,
      widths: widthStats(coreWidths), paragraphs: paragraphStats(coreParagraphs),
      proseAndLists: paragraphStats(coreParagraphs.filter(row => row.kind !== 'one-line block (includes headings/cells)')),
      oneLineBlocks: paragraphStats(coreParagraphs.filter(row => row.kind === 'one-line block (includes headings/cells)')),
      unassociatedFonts: unassociatedFonts.length, unavailableWidths },
    families: familyRows, fonts: fontRows, files: results, widths, paragraphs, unassociatedFonts };
  for (const result of results) expect(createHash('sha256').update(await readFile(result.file)).digest('hex'), `unchanged source ${result.file}`).toBe(result.sha256);
  await writeFile(`${OUTPUT}/font-survey.json`, JSON.stringify(report, null, 2) + '\n');
  await writeFile(`${OUTPUT}/font-inventory.csv`, ['scope,name,family,type,embedded,encoding,reuseGate,files,pages,eligiblePieces,checkedPieces',
    ...fontRows.map(row => [row.files.some(file => core.has(file)) ? 'core' : 'supplemental', row.name, row.family, row.type, row.embedded, row.encoding, row.reuseGate, row.files.length, row.pages.length, row.eligiblePieces, row.checkedPieces].map(value => JSON.stringify(value)).join(','))].join('\n') + '\n');
  await writeFile(`${OUTPUT}/family-widths.csv`, ['family,fallback,lines,averagePercent,worstNarrowerPercent,worstWiderPercent,paragraphs,measured,editedCanvasGrows,extraWordAddsLine',
    ...familyRows.map(row => [row.family, row.fallback, row.allLines.lines, row.allLines.meanPercent, row.allLines.worstNarrowerPercent, row.allLines.worstWiderPercent,
      row.paragraphs.total, row.paragraphs.measured, row.paragraphs.canvasEditedGrows, row.paragraphs.canvasExtraWordAddsLine].map(value => JSON.stringify(value)).join(','))].join('\n') + '\n');
  const familyTable = familyRows.map(row => `| ${cell(row.family)} | ${cell(row.fallback)} | ${row.allLines.lines} | ${row.allLines.meanPercent ?? 'n/a'} | ${row.allLines.worstNarrowerPercent ?? 'n/a'} | ${row.allLines.worstWiderPercent ?? 'n/a'} | ${row.paragraphs.measured}/${row.paragraphs.total} | ${row.paragraphs.canvasEditedGrows} | ${row.paragraphs.canvasExtraWordAddsLine} |`).join('\n');
  const inventoryTable = fontRows.filter(row => row.files.some(file => core.has(file))).map(row => `| ${cell(row.name)} | ${cell(row.family)} | ${cell(row.type)} | ${cell(row.embedded)} | ${cell(row.encoding)} | ${cell(row.reuseGate)} | ${row.eligiblePieces}/${row.checkedPieces} | ${row.files.length} |`).join('\n');
  const tables = `## Per-family measurements\n\n| Family | Fallback selected today | Measured line contributions | Average width delta % | Worst narrower % | Worst wider % | Paragraphs measured/total | Edited paragraphs taller than source | Added word adds a line vs reflow control |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n${familyTable}\n\n## Every used font variant\n\n| Font (subset stripped) | Family | PDF type | Embedded | Encoding | Resource reuse gate | Current extracted pieces accepted/checked | Core files |\n|---|---|---|---|---|---|---:|---:|\n${inventoryTable}\n`;
  await writeFile(`${OUTPUT}/tables.md`, tables);
  const stats = report.totals.paragraphs;
  const manifestTable = results.filter(row => core.has(row.file)).map((row, index) => `| ${index + 1} | ${cell(row.file)} | ${row.pages} | ${row.usedFonts} | ${row.lines} | ${row.paragraphs} | ${row.sha256} |`).join('\n');
  const simulationBreakdown = [
    ['All logical paragraphs', report.totals.paragraphs], ['Multiline blocks and list items', report.totals.proseAndLists], ['One-line blocks (including headings/cells)', report.totals.oneLineBlocks],
  ].map(([label, value]) => { const v = value as ReturnType<typeof paragraphStats>; return `| ${label} | ${v.total} | ${v.measured} | ${v.unmeasured} | ${v.canvasAlreadyGrows} | ${v.canvasEditedGrows} | ${v.canvasExtraWordAddsLine} | ${v.exportEditedGrows} |`; }).join('\n');
  const supplementalTable = supplemental.map(file => {
    const rows = paragraphs.filter(row => row.file === file), summary = paragraphStats(rows), entry = results.find(row => row.file === file)!;
    return `| ${file} | ${entry.pages} | ${summary.measured}/${summary.total} | ${summary.canvasAlreadyGrows} | ${summary.canvasEditedGrows} | ${summary.canvasExtraWordAddsLine} |`;
  }).join('\n');
  const diagnosticTable = ['Calibri', 'Arial', 'Arial Black', 'HelveticaNowText', 'Organic', 'ZuumeRough', 'Aptos Narrow', 'Times New Roman'].flatMap(name => {
    const row = familyRows.find(value => value.family === name); if (!row) return [];
    return [`| ${name} | ${row.allLines.meanPercent ?? 'n/a'} | ${row.allLines.worstWiderPercent ?? 'n/a'} | ${row.fallbackRequired.lines} | ${row.paragraphs.canvasEditedGrows}/${row.paragraphs.measured} |`];
  }).join('\n');
  const document = `# Task 78 - Change 0: font measurement\n\nMeasured 2026-10-15 on branch \`font-match\`, from \`main\`. Change 0 only: no application code, font assets, dependencies, reuse gates, grouping or layout rules changed. Changes 1-5 are not built. Nothing committed. User review is required before Change 1.\n\n## Coverage and headline result\n\n- ${files.length} distinct corpus paths, ${report.totals.pages} pages, ${report.totals.lines} source text lines, ${report.totals.usedFontVariants} used font/resource variants, ${report.totals.families} families.\n- ${results.filter(row => core.has(row.file) && row.usedFonts === 0).length} corpus files have no painted text fonts; they remain in the 47-file manifest.\n- ${coreWidths.length} family/line width contributions measured; exclusions are counted below, not recorded as zero error.\n- ${stats.measured}/${stats.total} logical paragraphs simulated; ${stats.unmeasured} explicitly unmeasured. Adding the word \`${WORD}\` gives ${stats.canvasEditedGrows} paragraphs taller than the source, but ${stats.canvasAlreadyGrows} already grow when reflowed without that word. The extra word adds a line versus the reflow control in ${stats.canvasExtraWordAddsLine} cases. These are not all font-substitution defects.\n- All source-file SHA-256 hashes were checked again after measurement and are unchanged. ${unassociatedFonts.length} unresolved raw-font metadata matches.\n\n## How to read this measurement\n\n1. The 47-file corpus is exactly the accepted Step 5d \`SQUEEZE_SCOPE\` manifest: the 45 paths in \`tmp/5d/source-text-before.json\`, plus Bhutan and Corporate. Distinct paths/copies count separately, as before; this is not 47 unique-content hashes. Green and NMAT are separate supplemental examples, excluded from core totals. Every page is inspected, including pages with no text.\n2. A font is counted only when a visible text-show operator uses it; invisible mode 3 and clip-only mode 7 are excluded. Fonts inside form XObjects are included through pdf.js's expanded operator list. PDF type, embedding and encoding come from original resource dictionaries, not the browser's converted font type. Type3 embedding means its CharProcs are present, not a reusable TTF. Subset prefixes are stripped only for display/grouping.\n3. Generic names such as CIDFont+F3 are kept in the inventory. Their actual family is read from the embedded SFNT name table when available; no family is guessed from how it looks. A name used by different families remains separate. The resource gate is the existing \`resolvePageFontResource\`; accepted/checked additionally calls \`measureTextWithPageFont\` on current extracted pieces. Acceptance of old text does not mean a newly typed character exists in the subset.\n4. Width delta = 100 x (fallback width / source width - 1), at the same point size. Positive is wider; negative is narrower. Source and fallback widths are sums of nominal glyph advances (fallback kerning disabled by measuring characters independently), so TJ, character/word spacing, horizontal squeezing and justification do not masquerade as font differences. Means are unweighted averages of measured family contributions to source lines. A mixed-family line contributes once per family, and bold/italic source styles choose the same fallback variants as today. Both narrower and wider extremes are retained; n/a is not zero.\n5. The width table shows today's fallback even where reuse succeeds (a counterfactual comparison). Raw JSON also separates the fallback-required subset, so this does not imply the app substitutes every such line. Current source-font reuse and synthetic weight/slant behavior are unchanged.\n6. Simulation appends one space and \`${WORD}\` in the final span's style to each logical paragraph from the current paragraph/list detection. It keeps the source column, indentation, justification and measured minimum word gap. It calls the existing \`wrapTextParagraphs\` with source-preservation disabled to measure reflow, not a no-op. Each paragraph is measured independently, so one paragraph's edit cannot contaminate another's count. Heading/cell/label one-line blocks and actual multiline/list text are reported separately. At a fixed source width many one-line labels naturally need another row when extended; the app may allow those editors to grow wider.\n7. The screen-model simulation uses the production CSS font list, pdf.js font data registered under its loaded name, and local \`@napi-rs/canvas\` measurement. It is a Node/Skia measurement, NOT a Chrome typing, caret, DOM, IME or export/reopen test. The export-route column is a width-model comparison using today's reuse-or-standard-font selection; it is NOT an exported-page line count. Step 5d's committed per-piece scaling means an intrinsically wider fallback does not by itself prove the saved PDF grows.\n8. A source-font control is additionally recorded where every added letter has a known advance in that exact subset. Unsupported Unicode, Indic export, missing/ambiguous advances or unavailable source spans are explicit exclusions. We do not silently drop characters to obtain a smaller width. No twin fonts were downloaded, licensed, selected or implemented in this change.\n\n## Selected findings (not a font implementation)\n\n| Family | Mean width delta % | Worst wider % | Fallback-required line samples | Taller edited paragraphs / simulated |\n|---|---:|---:|---:|---:|\n${diagnosticTable}\n\n${tables}\n## Paragraph simulation accounting\n\n| Scope | Logical paragraphs | Simulated | Unmeasured | Reflow already taller | After adding extra, taller than source | Extra adds line vs reflow | Reuse-or-fallback width model taller |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${simulationBreakdown}\n\nThe fallback-only edited-width model grows in ${stats.fallbackEditedGrows} cases. The exact-subset source-font control is available for ${stats.sourceControlMeasured} cases and grows in ${stats.sourceControlEditedGrows}; it is not extrapolated to the other subsets. Mixed-family paragraphs are in the total accounting and in the raw rows, not assigned to a single family.\n\nUnmeasured width contributions: ${JSON.stringify(unavailableWidths)}.\n\nUnmeasured paragraph reasons: ${JSON.stringify(coreParagraphs.filter(row => row.unmeasured).reduce<Record<string, number>>((sum, row) => { sum[row.unmeasured!] = (sum[row.unmeasured!] ?? 0) + 1; return sum; }, {}))}.\n\n## Supplemental examples (not in 47-file totals)\n\n| File | Pages | Simulated/total paragraphs | Reflow already taller | Edited taller than source | Extra adds a line vs reflow |\n|---|---:|---:|---:|---:|---:|\n${supplementalTable}\n\n## Reproduce and inspect\n\nPowerShell, from the repository root:\n\n\`\`\`powershell\n$env:TASK78_FONTS='1'\nnode node_modules/vitest/vitest.mjs run src/lib/fonts/task78Fonts.local.test.ts --maxWorkers=1 --minWorkers=1\n\`\`\`\n\nMeasurement implementation: \`src/lib/fonts/task78Survey.local.ts\`. Machine-readable results: \`tmp/task78/font-survey.json\` (every width and paragraph row, resource refusals, per-file SHA-256), \`font-inventory.csv\`, \`family-widths.csv\`, \`tables.md\`, and \`vitest.json\` in the same directory. Font CSV has an explicit core/supplemental scope. No app imports the harness.\n\nLocal runner note: the installed Windows ARM canvas package lacked its ICU text-shaping data. The installed Edge icudtl.dat was copied beside that ignored native dependency to allow measurement. No package manifest or lockfile was changed. This is local test setup, not an app change.\n\n## Exact 47-file manifest\n\n| # | File | Pages | Used variants | Source lines | Logical paragraphs | SHA-256 |\n|---:|---|---:|---:|---:|---:|---|\n${manifestTable}\n`;
  await writeFile(`${OUTPUT}/report.md`, document);
  process.stdout.write(`TASK78 TOTAL ${JSON.stringify(report.totals)}\n`);
  expect(results.filter(row => core.has(row.file))).toHaveLength(47);
  expect(unassociatedFonts, 'all used fonts must match raw PDF resources').toEqual([]);
  expect(widths.length).toBeGreaterThan(0);
}
