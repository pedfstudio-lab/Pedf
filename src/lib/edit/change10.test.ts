/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { richTextToHtml, serializeRichText } from './richText';
import { insertParagraphBreak, insertParagraphText, mergeParagraphBackward, normalizeParagraphDom } from './paragraphDom';
import { sourceParagraphLineHeight, sourceParagraphs } from './paragraphSeed';
import { wrapTextParagraphs } from './paragraphLayout';
import { buildTextBlockEdits } from './buildTextEdits';
import { sameTextEditSession } from './textEditSession';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';

const style = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
const layouts = [{ gapBeforePt: 0, firstIndentPt: 8, restIndentPt: 4 }, { gapBeforePt: 3, firstIndentPt: 28.8, restIndentPt: 0 }];
function editor(text = 'First paragraph\nSecond paragraph') {
  const root = document.createElement('div'); root.dataset.pdfParagraphEditor = 'true'; root.contentEditable = 'true';
  root.innerHTML = richTextToHtml(text, style, undefined, 2, layouts); document.body.append(root);
  const cache = new Map(layouts.map((layout, index) => [`source-${index}`, layout]));
  const normalize = () => normalizeParagraphDom(root, cache, 3, 2);
  return { root, normalize };
}
function caret(node: Node, offset: number) { const range = document.createRange(); range.setStart(node, offset); range.collapse(true); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); }

describe('Change 10 paragraph HTML and input', () => {
  it('round-trips measured gaps and first/hanging indents, including zoom, as a no-op', () => {
    const { root } = editor();
    expect((root.children[1] as HTMLElement).style.marginTop).toBe('6px');
    expect((root.children[0] as HTMLElement).style.paddingLeft).toBe('8px');
    expect((root.children[0] as HTMLElement).style.textIndent).toBe('8px');
    const value = serializeRichText(root, style, 2);
    expect(value.paragraphs).toEqual(layouts);
    expect(sameTextEditSession({ text: 'First paragraph\nSecond paragraph', style, paragraphs: layouts, width: 200, height: 40, dx: 0, dy: 0 }, { ...value, width: 200, height: 40, dx: 0, dy: 0 })).toBe(true);
  });
  it('Enter inherits indent and the common gap, and a start Backspace removes both', () => {
    const { root, normalize } = editor();
    caret(root.firstChild!.firstChild!, 6);
    expect(insertParagraphBreak(root)).toBe(true); normalize();
    const split = serializeRichText(root, style, 2);
    expect(split.text).toBe('First \nparagraph\nSecond paragraph');
    expect(split.paragraphs?.[1]).toEqual({ gapBeforePt: 3, firstIndentPt: 8, restIndentPt: 4 });
    const added = root.children[1]!; caret(added.firstChild!, 0);
    expect(mergeParagraphBackward(root)).toBe(true); normalize();
    expect(serializeRichText(root, style, 2)).toMatchObject({ text: 'First paragraph\nSecond paragraph', paragraphs: layouts });
  });
  it('multi-line paste creates paragraphs without rewriting text nodes on later input', () => {
    const { root, normalize } = editor(); caret(root.firstChild!.firstChild!, 5);
    insertParagraphText(root, 'one\ntwo'); normalize();
    const value = serializeRichText(root, style, 2);
    expect(value.text).toBe('Firstone\ntwo paragraph\nSecond paragraph');
    expect(value.paragraphs).toHaveLength(3);
    const nodes = [...root.querySelectorAll('[data-pdf-paragraph]')]; normalize();
    expect([...root.querySelectorAll('[data-pdf-paragraph]')]).toEqual(nodes);
  });
  it('keeps bold/italic and colour across paragraph boundaries', () => {
    const root = document.createElement('div');
    const text = 'Heading\nBody';
    const spans = [{ text: 'Heading\n', bold: true, italic: false }, { text: 'Body', bold: false, italic: true, color: { r: 1, g: 0, b: 0 }, colorKnown: true }];
    root.innerHTML = richTextToHtml(text, style, spans, 1, layouts);
    expect(serializeRichText(root, style)).toMatchObject({ text, spans, paragraphs: layouts });
  });
  it('escapes quoted font families so body text never inherits a heading font by malformed HTML', () => {
    const root = document.createElement('div');
    root.innerHTML = richTextToHtml('Heading\nBody', { ...style, fontRef: 'heading-font', italic: true }, [
      { text: 'Heading\n', bold: true, italic: true }, { text: 'Body', bold: false, italic: false, fontRef: 'body-font' },
    ], 1, layouts);
    const body = root.children[1]!.firstChild as HTMLElement;
    expect(body.style.fontFamily).toContain('body-font');
    expect(body.style.fontStyle).toBe('normal');
    expect(serializeRichText(root, { ...style, fontRef: 'heading-font', italic: true }).spans?.at(-1)).toMatchObject({ fontRef: 'body-font', italic: false });
  });
});

function line(text: string, y: number, x = 40, width = 200): TextLine {
  const rect = { x, y, w: width, h: 10 };
  return { pageIndex: 0, text, baselineY: y, rect, style, runs: [{ pageIndex: 0, text, rect, style, characterWidthsPt: [...text].map(() => width / text.length), spaceWidthPt: 2 }] };
}
describe('Change 10 paragraph model', () => {
  it('uses a note’s repeated local pitch rather than wider page/list spacing, without scaling it again for its heading', () => {
    const heading = line('1. Timings:', 700, 40, 55);
    const headingStyle = { ...style, fontSizePt: 11.04, bold: true };
    const lines = [{ ...heading, style: headingStyle, runs: heading.runs.map(run => ({ ...run, style: headingStyle })) },
      line('First full body line', 686.8, 48.04, 191.96), line('last line.', 673.96, 48.04, 50)];
    const block: TextBlock = { pageIndex: 0, text: lines.map(line => line.text).join('\n'), rect: { x: 40, y: 673.96, w: 200, h: 37.08 }, lines, style, lineHeightPt: 13.02, paragraphLineHeightPt: 16, topBaselineY: 700 };
    expect(sourceParagraphLineHeight(block)).toBeCloseTo(13.02);
    const next = { text: '1. Timings:\nOther full body line last line.', style, width: 200, height: 40, dx: 0, dy: 0,
      paragraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }, { gapBeforePt: 0, firstIndentPt: 8.04, restIndentPt: 8.04 }] };
    const built = buildTextBlockEdits(block, next, [
      { text: '1. Timings:', spans: [{ text: '1. Timings:', fontSizePt: 11.04, bold: true, italic: false }], paragraphIndex: 0, paragraphStart: true },
      { text: 'Other full body line', paragraphIndex: 1, paragraphStart: true },
      { text: 'last line.', paragraphIndex: 1, paragraphStart: false },
    ], 1);
    // Not 13.02 * 11.04/10 (pitch scaled again). The editor's CSS line box:
    // the pitch plus the 11.04pt heading's larger share of leading below its
    // baseline, 1.04 * (1.302 - k) / 2 with Helvetica's k = 0.905 - 0.212.
    expect(built.texts[1]!.rect.y).toBeCloseTo(700 - 13.02 - 1.04 * (1.302 - 0.693) / 2);
    expect(built.texts[1]!.rect.x).toBeCloseTo(48.04);
    expect(built.texts[2]!.rect.y).toBeCloseTo(673.96);
  });
  it('measures a 3pt paragraph gap and a 28.8pt first-line indent', () => {
    const lines = [line('Heading', 700, 40, 45), line('First full body line', 685), line('last line.', 673, 40, 50), line('In fact, another full line', 658, 68.8, 171.2), line('last line again.', 646, 40, 75)];
    const block: TextBlock = { pageIndex: 0, text: lines.map(line => line.text).join('\n'), rect: { x: 40, y: 646, w: 200, h: 64 }, lines, style, lineHeightPt: 12, topBaselineY: 700 };
    const seeded = sourceParagraphs(block);
    expect(seeded.layouts).toEqual([{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }, { gapBeforePt: 3, firstIndentPt: 0, restIndentPt: 0 }, { gapBeforePt: 3, firstIndentPt: 28.799999999999997, restIndentPt: 0 }]);
    const next = { text: seeded.text.replace('First', 'Other'), style, width: 200, height: 80, dx: 0, dy: 0, paragraphs: seeded.layouts, preserveSourceWrapping: true };
    const wrapped = wrapTextParagraphs(next, text => text.length * 10, block);
    const built = buildTextBlockEdits(block, next, wrapped, 1);
    expect(built.texts[0]?.boxParagraphs).toEqual(seeded.layouts);
    expect(built.texts.slice(1).every(edit => edit.boxParagraphs === undefined)).toBe(true);
    const inFact = built.texts.find(edit => edit.text.startsWith('In fact,'))!;
    expect(inFact.rect.x).toBeCloseTo(68.8);
    expect(inFact.rect.y).toBe(658);
  });
  it('wraps first and continuation lines using their different available widths', () => {
    const next = { text: 'alpha beta gamma delta', style, width: 60, height: 100, dx: 0, dy: 0, paragraphs: [{ gapBeforePt: 0, firstIndentPt: 20, restIndentPt: 0 }] };
    const lines = wrapTextParagraphs(next, text => text.length * 5);
    expect(lines.map(line => line.text)).toEqual(['alpha', 'beta gamma', 'delta']);
  });
});
