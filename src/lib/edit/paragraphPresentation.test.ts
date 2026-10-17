/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { TextStyle } from '@/lib/export/types';
import { paragraphPresentation, flowSelectedParagraphs, snapshotParagraphs, refreshParagraphPresentation, recalibrateParagraphRows } from './paragraphPresentation';
import { serializeRichText } from './richText';
import { sourceParagraphLineHeight, sourceParagraphs } from './paragraphSeed';

const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
function fixture(): TextBlock {
  const lines = ['alpha beta', 'gamma delta', 'other words', 'last words'].map((text, index) => {
    const y = 700 - index * 20 - (index >= 2 ? 20 : 0), rect = { x: 40, y, w: 104, h: 10 };
    return { pageIndex: 0, text, rect, baselineY: y, style, runs: [{ pageIndex: 0, text, rect, style, spaceWidthPt: 5, characterWidthsPt: [...text].map(() => 90 / text.length),
      metrics: { matrix: [10, 0, 0, 10, 40, y] as const, x: 40, baselineY: y, widthPt: 90 } }] };
  });
  return { pageIndex: 0, text: lines.map(line => line.text).join('\n'), style, lines, rect: { x: 40, y: 620, w: 90, h: 90 }, topBaselineY: 700, lineHeightPt: 20 };
}
afterEach(() => { document.body.replaceChildren(); window.getSelection()?.removeAllRanges(); });
describe('measured paragraph presentation', () => {
  it('keeps a larger source step inside an existing soft group when leading is corrected', () => {
    const texts = ['alpha beta', 'long next line', 'bold label', 'short', 'other words', 'last words', 'short', 'short'];
    const steps = [12, 16, 16, 12, 16, 16, 16], widths = [90, 90, 40, 90, 40, 30, 30, 30];
    let y = 700;
    const lines = texts.map((text, index) => {
      y -= index ? steps[index - 1]! : 0;
      const rect = { x: 40, y, w: widths[index]!, h: 10 };
      return { pageIndex: 0, text, rect, baselineY: y, style, runs: [{ pageIndex: 0, text, rect, style,
        characterWidthsPt: [...text].map(() => rect.w / text.length), spaceWidthPt: 2,
        metrics: { matrix: [10, 0, 0, 10, 40, y] as const, x: 40, baselineY: y, widthPt: rect.w } }] };
    });
    const block = { ...fixture(), text: texts.join('\n'), lines, rect: { x: 40, y, w: 90, h: 700 - y + 10 } };
    const seed = sourceParagraphs(block);
    expect(sourceParagraphLineHeight(block)).toBe(12);
    const value = paragraphPresentation(block, seed.text, style, 2, text => text.length * 2);
    expect(value.html).toContain('margin-top:var(--pdf-source-row-gap,8px)');
    const root = document.createElement('div'); root.innerHTML = value.html; document.body.append(root);
    const paragraph = root.querySelector<HTMLElement>('[data-pdf-measured-paragraph]')!;
    const node = paragraph.querySelector('[data-pdf-source-row]')!.firstChild!;
    const range = document.createRange(); range.setStart(node, 0); range.collapse(true); window.getSelection()!.addRange(range);
    const snapshots = snapshotParagraphs(root, style, 2);
    flowSelectedParagraphs(root);
    expect(paragraph.style.getPropertyValue('--pdf-source-row-gap')).toBe('0px');
    refreshParagraphPresentation(root, snapshots, style, 2);
    expect(paragraph.style.getPropertyValue('--pdf-source-row-gap')).toBe('');
  });
  it('does not migrate the presentation of old saved rows when a late font is wide', () => {
    const root=document.createElement('div');
    root.innerHTML='<div data-pdf-measured-paragraph="true" data-pdf-saved-rows="true"><span data-pdf-source-row="true" data-pdf-source-width-pt="10">alpha beta</span></div>';
    recalibrateParagraphRows(root,style,1,text=>text.length*10);
    const paragraph=root.firstElementChild as HTMLElement;
    expect(paragraph.dataset.pdfGapReflow).toBeUndefined();
    expect(paragraph.dataset.pdfFlowing).toBeUndefined();
    expect((paragraph.firstElementChild as HTMLElement).style.wordSpacing).toContain('-90px');
  });
  it('shows source rows but serializes only logical paragraph boundaries', () => {
    const block = fixture(), text = 'alpha beta gamma delta\nother words last words';
    const value = paragraphPresentation(block, text, style, 1, text => text.length * 10);
    expect(value.fallbacks).toEqual([undefined, undefined]);
    const root = document.createElement('div'); root.dataset.pdfParagraphEditor = 'true'; root.innerHTML = value.html;
    document.body.append(root);
    expect(root.querySelectorAll('[data-pdf-source-row]')).toHaveLength(4);
    expect(serializeRichText(root, style).text).toBe(text);
    expect(serializeRichText(root, style).paragraphs).toHaveLength(2);
    expect(value.html).toContain('word-spacing:var(--pdf-word-space,4px)');
    expect(value.lines[0]![0]!.sourcePosition?.y).toBe(700);
  });
  it('keeps the space joining two rows inside the earlier row, never as a blank line between them', () => {
    // In the editor's pre-wrap text, a space of its own between two block rows renders as an
    // empty line: every row then took two lines of height (user report, Corporate p16).
    const block = fixture(), text = 'alpha beta gamma delta\nother words last words';
    const value = paragraphPresentation(block, text, style, 1, text => text.length * 10);
    const root = document.createElement('div'); root.innerHTML = value.html; document.body.append(root);
    for (const paragraph of root.querySelectorAll<HTMLElement>('[data-pdf-measured-paragraph]')) {
      const children = [...paragraph.childNodes];
      expect(children.every(node => node instanceof HTMLElement && node.hasAttribute('data-pdf-source-row'))).toBe(true);
      const rows = children.map(node => node.textContent ?? '');
      expect(rows.slice(0, -1).every(row => row.endsWith(' '))).toBe(true);
      expect(rows.at(-1)!.endsWith(' ')).toBe(false);
    }
    expect(serializeRichText(root, style).text).toBe(text);
  });
  it('flows only the selected paragraph, retaining nodes, selection and the other rows', () => {
    const block = fixture(), text = 'alpha beta gamma delta\nother words last words';
    const value = paragraphPresentation(block, text, style, 1, text => text.length * 10);
    const root = document.createElement('div'); root.innerHTML = value.html; document.body.append(root);
    const paragraphs = root.querySelectorAll<HTMLElement>('[data-pdf-measured-paragraph]');
    const node = paragraphs[0]!.querySelector('[data-pdf-source-row]')!.firstChild!.firstChild!;
    const range = document.createRange(); range.setStart(node, 1); range.collapse(true); window.getSelection()!.addRange(range);
    const initial = snapshotParagraphs(root, style, 1);
    flowSelectedParagraphs(root);
    expect(paragraphs[0]!.dataset.pdfFlowing).toBe('true');
    expect(paragraphs[1]!.dataset.pdfFlowing).toBeUndefined();
    expect(window.getSelection()!.anchorNode).toBe(node); expect(window.getSelection()!.anchorOffset).toBe(1);
    node.nodeValue = node.nodeValue + 'X'; refreshParagraphPresentation(root, initial, style, 1);
    expect(paragraphs[0]!.dataset.pdfFlowing).toBe('true'); expect(paragraphs[1]!.dataset.pdfFlowing).toBe('false');
    node.nodeValue = node.nodeValue!.slice(0, -1); refreshParagraphPresentation(root, initial, style, 1);
    expect(paragraphs[0]!.dataset.pdfFlowing).toBe('false');
    expect(root.querySelector('[data-pdf-source-row]')!.firstChild!.firstChild).toBe(node);
  });
  it('names missing metrics rather than drawing pretend positioned rows', () => {
    const value = fixture();
    const block = { ...value, lines: value.lines.map(line => ({ ...line, runs: line.runs.map(run => ({ ...run, metrics: undefined })) })) };
    const result = paragraphPresentation(block, 'alpha beta gamma delta\nother words last words', style, 1, () => 1);
    expect(result.fallbacks).toEqual(['source-metrics-unavailable', 'source-metrics-unavailable']);
    expect(result.html).not.toContain('data-pdf-source-row');
  });
  it('recalibrates late font advances without changing text or flowing paragraphs', () => {
    const value = paragraphPresentation(fixture(), 'alpha beta gamma delta\nother words last words', style, 2, text => text.length * 10);
    const root = document.createElement('div'); root.innerHTML = value.html; document.body.append(root);
    const before = root.textContent;
    recalibrateParagraphRows(root, style, 2, text => text.length * 8);
    const row = root.querySelector<HTMLElement>('[data-pdf-source-row]')!;
    expect(row.style.wordSpacing).toContain('48px');
    root.querySelector<HTMLElement>('[data-pdf-measured-paragraph]')!.dataset.pdfFlowing = 'true';
    const saved = row.style.wordSpacing;
    recalibrateParagraphRows(root, style, 2, text => text.length * 5);
    expect(row.style.wordSpacing).toBe(saved);
    expect(root.textContent).toBe(before);
  });
  it('flows an unfit source paragraph rather than erasing its word spaces', () => {
    const block=fixture();
    const value=paragraphPresentation(block,'alpha beta gamma delta\nother words last words',style,1,text=>text.length*30);
    expect(value.fallbacks).toEqual(['word-gap-below-readable-minimum','word-gap-below-readable-minimum']);
    expect(value.html).not.toContain('data-pdf-source-row');
    const root=document.createElement('div');root.innerHTML=value.html;
    expect(serializeRichText(root,style).text).toBe('alpha beta gamma delta\nother words last words');
  });
});
