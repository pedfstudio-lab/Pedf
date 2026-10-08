/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import type { CoverEdit, TextParagraphLayout } from '@/lib/export/types';
import type { RuleLine } from '@/lib/pdf/ruleLines';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
import { richTextToHtml, serializeRichText } from './richText';
import { alignParagraphLayouts, ZERO_PARAGRAPH } from './paragraphDom';
import { wrapSelectionWithStyle } from './styleSelection';
import { buildTextBlockEdits } from './buildTextEdits';
import { coverRectForRuleLine } from './buildLineEdits';
import { continuesCoverRun } from './coverTransactions';

const style = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };

function paragraphEditor(
  text: string,
  spans?: Parameters<typeof richTextToHtml>[2],
  layouts: readonly TextParagraphLayout[] = text.split('\n').map(() => ZERO_PARAGRAPH),
) {
  const root = document.createElement('div');
  root.dataset.pdfParagraphEditor = 'true';
  root.innerHTML = richTextToHtml(text, style, spans, 1, layouts);
  document.body.append(root);
  return root;
}

describe('paragraph editor line breaks', () => {
  it('reads Chrome’s new empty paragraph after styled text as one blank line', () => {
    // Enter at the end of bold "Highlights": Chrome copies the bold span into
    // the new paragraph and puts the placeholder break inside it.
    const root = paragraphEditor('Highlights\nBody', [
      { text: 'Highlights\n', bold: true, italic: false }, { text: 'Body', bold: false, italic: false },
    ]);
    const empty = root.children[0]!.cloneNode(false) as HTMLElement;
    empty.innerHTML = '<span style="font-weight:bold"><br></span>';
    root.children[0]!.after(empty);
    const value = serializeRichText(root, style);
    expect(value.text).toBe('Highlights\n\nBody');
    expect(value.paragraphs).toHaveLength(3);
  });

  it('gives a break inside a paragraph its own line and layout, at the hanging indent', () => {
    const root = paragraphEditor('onetwo', undefined, [{ gapBeforePt: 0, firstIndentPt: 8, restIndentPt: 4 }]);
    root.children[0]!.innerHTML = 'one<br>two';
    expect(serializeRichText(root, style)).toMatchObject({
      text: 'one\ntwo',
      paragraphs: [{ gapBeforePt: 0, firstIndentPt: 8, restIndentPt: 4 }, { gapBeforePt: 0, firstIndentPt: 4, restIndentPt: 4 }],
    });
  });

  it('draws no extra line for a break that ends its paragraph', () => {
    const root = paragraphEditor('one\nBody');
    root.children[0]!.innerHTML = '<span style="font-weight:bold">one<br></span>';
    const value = serializeRichText(root, style);
    expect(value.text).toBe('one\nBody');
    expect(value.paragraphs).toHaveLength(2);
  });

  it('always returns one layout per text line', () => {
    const layout = { gapBeforePt: 3, firstIndentPt: 8, restIndentPt: 4 };
    expect(alignParagraphLayouts('a\nb\nc', [ZERO_PARAGRAPH, layout])).toEqual([ZERO_PARAGRAPH, layout, { gapBeforePt: 0, firstIndentPt: 4, restIndentPt: 4 }]);
    expect(alignParagraphLayouts('a', [ZERO_PARAGRAPH, layout])).toEqual([ZERO_PARAGRAPH]);
  });
});

describe('styling a selection across paragraphs', () => {
  it('keeps two paragraphs two, with nothing nested', () => {
    const root = paragraphEditor('First paragraph\nSecond paragraph');
    const range = document.createRange();
    range.setStart(root.children[0]!.firstChild!, 6);
    range.setEnd(root.children[1]!.firstChild!, 6);
    const selected = wrapSelectionWithStyle(root, range, { fontSize: '20px' }, { fontSizePt: '20' }, ['fontSize']);
    expect(root.children).toHaveLength(2);
    expect([...root.children].every((child) => child.hasAttribute('data-pdf-paragraph'))).toBe(true);
    expect(root.querySelectorAll('[data-pdf-paragraph] [data-pdf-paragraph]')).toHaveLength(0);
    expect(selected.toString()).toBe('paragraphSecond');
    const value = serializeRichText(root, style);
    expect(value.text).toBe('First paragraph\nSecond paragraph');
    expect(value.paragraphs).toHaveLength(2);
    expect(value.spans?.filter((span) => span.fontSizePt === 20).map((span) => span.text)).toEqual(['paragraph\nSecond']);
  });

  it('select-all leaves no empty first paragraph', () => {
    const root = paragraphEditor('First paragraph\nSecond paragraph');
    const range = document.createRange();
    range.selectNodeContents(root);
    wrapSelectionWithStyle(root, range, { color: 'rgb(255, 0, 0)' }, { textColor: '1,0,0', colorKnown: 'true' }, ['color']);
    expect(root.children).toHaveLength(2);
    expect([...root.children].map((child) => child.textContent)).toEqual(['First paragraph', 'Second paragraph']);
    const value = serializeRichText(root, style);
    expect(value).toMatchObject({ text: 'First paragraph\nSecond paragraph', style: { color: { r: 1, g: 0, b: 0 } } });
    expect(value.paragraphs).toHaveLength(2);
  });
});

function line(text: string, baselineY: number, size = 10): TextLine {
  const lineStyle = { ...style, fontSizePt: size };
  const rect = { x: 40, y: baselineY, w: 200, h: size };
  return { pageIndex: 0, text, baselineY, rect, style: lineStyle, runs: [{ pageIndex: 0, text, rect, style: lineStyle }] };
}
function block(lines: TextLine[], paragraphLineHeightPt?: number): TextBlock {
  return {
    pageIndex: 0, text: lines.map((item) => item.text).join('\n'), rect: { x: 40, y: lines.at(-1)!.baselineY, w: 200, h: 40 },
    topBaselineY: lines[0]!.baselineY, lineHeightPt: 12, style: lines[0]!.style, lines,
    ...(paragraphLineHeightPt ? { paragraphLineHeightPt } : {}),
  };
}

describe('saved line spacing matches the paragraph editor', () => {
  it('spaces a line with one big word as CSS does, not by the big size above and below', () => {
    // Ladakh: 18.4pt body on a 20.3pt pitch, "Pangong" made 36pt.
    const source = block([line('a', 700, 18.4), line('b', 679.7, 18.4), line('c', 659.4, 18.4)]);
    const body = { ...style, fontSizePt: 18.4 };
    const next = {
      text: 'words. From the Pangong, from starlit skies', style: body, width: 200, height: 60, dx: 0, dy: 0,
      paragraphs: [ZERO_PARAGRAPH], fontMetrics: { ascent: 0.9, descent: 0.2 },
    };
    const built = buildTextBlockEdits(source, next, [
      { text: 'words. From the', paragraphIndex: 0, paragraphStart: true },
      { text: 'Pangong, from', paragraphIndex: 0, paragraphStart: false, spans: [
        { text: 'Pangong', bold: false, italic: false, fontSizePt: 36 }, { text: ', from', bold: false, italic: false },
      ] },
      { text: 'starlit skies', paragraphIndex: 0, paragraphStart: false },
    ], 1);
    const ratio = 20.3 / 18.4, k = 0.9 - 0.2;
    // Above the big line: the body's share below + the 36pt share above.
    const toBig = (18.4 * (ratio - k) + 36 * (ratio + k)) / 2;
    // Below it: the 36pt share below + the body's share above.
    const fromBig = (36 * (ratio - k) + 18.4 * (ratio + k)) / 2;
    expect(built.texts[1]!.rect.y).toBeCloseTo(700 - toBig, 6);
    expect(built.texts[2]!.rect.y).toBeCloseTo(700 - toBig - fromBig, 6);
    // Uniform lines still step by exactly the pitch.
    const plain = buildTextBlockEdits(source, next, [
      { text: 'words. From the', paragraphIndex: 0, paragraphStart: true },
      { text: 'starlit skies', paragraphIndex: 0, paragraphStart: false },
    ], 1);
    expect(plain.texts[1]!.rect.y).toBeCloseTo(700 - 20.3, 6);
  });

  it('keeps untouched lines above the change in place when the line count changes', () => {
    const source = block([line('Alpha line one', 700), line('Beta line two', 687.6), line('Gamma end.', 676)], 12);
    const built = buildTextBlockEdits(source, {
      text: 'Alpha line one Beta line two Gamma end. Added words', style, width: 200, height: 40, dx: 0, dy: 0,
      paragraphs: [ZERO_PARAGRAPH],
    }, [
      { text: 'Alpha line one', paragraphIndex: 0, paragraphStart: true },
      { text: 'Beta line two', paragraphIndex: 0, paragraphStart: false },
      { text: 'Gamma end. Added', paragraphIndex: 0, paragraphStart: false },
      { text: 'words', paragraphIndex: 0, paragraphStart: false },
    ], 1);
    expect(built.texts.map((edit) => edit.rect.y)).toEqual([700, 687.6, 675.6, 663.6].map((y) => expect.closeTo(y, 6)));
  });
});

describe('an old edit’s first cover after a delete', () => {
  const rule: RuleLine = { pageIndex: 0, orientation: 'horizontal', x1: 40, y1: 500, x2: 300, y2: 500, thicknessPt: 1, color: { r: 0, g: 0, b: 0 } };
  const textCover = (z: number): CoverEdit => ({
    id: `t${z}`, kind: 'cover', pageIndex: 0, rect: { x: 40, y: 700 - z * 12, w: 200, h: 12 }, z, sampleBackground: true,
    replaces: [{ text: 'line', rect: { x: 40, y: 700 - z * 12, w: 200, h: 10 } }],
  });
  const run = (before: CoverEdit) => new Map([[before.z, before], [5, textCover(5)]]);

  it('starts its own box after a deleted picture or rule line', () => {
    const picture: CoverEdit = { id: 'p', kind: 'cover', pageIndex: 0, rect: { x: 300, y: 300, w: 50, h: 50 }, z: 4,
      sampleBackground: false, replacesImages: [{ kind: 'image', rect: { x: 300, y: 300, w: 50, h: 50 } }] };
    const ruleCover: CoverEdit = { id: 'r', kind: 'cover', pageIndex: 0, rect: coverRectForRuleLine(rule), z: 4, sampleBackground: true };
    expect(continuesCoverRun(textCover(5), run(picture), [rule])).toBe(false);
    expect(continuesCoverRun(textCover(5), run(ruleCover), [rule])).toBe(false);
    expect(continuesCoverRun(textCover(5), new Map([[5, textCover(5)]]), [rule])).toBe(false);
  });

  it('is an interior line of the same box after a text cover', () => {
    expect(continuesCoverRun(textCover(5), run(textCover(4)), [rule])).toBe(true);
  });
});
