/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { TextStyle } from '@/lib/export/types';
import { paragraphPresentation, flowSelectedParagraphs, snapshotParagraphs, refreshParagraphPresentation, recalibrateParagraphRows } from './paragraphPresentation';
import { serializeRichText } from './richText';

const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
function fixture(): TextBlock {
  const lines = ['alpha beta', 'gamma delta', 'other words', 'last words'].map((text, index) => {
    const y = 700 - index * 20 - (index >= 2 ? 20 : 0), rect = { x: 40, y, w: 90, h: 10 };
    return { pageIndex: 0, text, rect, baselineY: y, style, runs: [{ pageIndex: 0, text, rect, style, spaceWidthPt: 5, characterWidthsPt: [...text].map(() => 90 / text.length),
      metrics: { matrix: [10, 0, 0, 10, 40, y] as const, x: 40, baselineY: y, widthPt: 90 } }] };
  });
  return { pageIndex: 0, text: lines.map(line => line.text).join('\n'), style, lines, rect: { x: 40, y: 620, w: 90, h: 90 }, topBaselineY: 700, lineHeightPt: 20 };
}
afterEach(() => { document.body.replaceChildren(); window.getSelection()?.removeAllRanges(); });
describe('measured paragraph presentation', () => {
  it('shows source rows but serializes only logical paragraph boundaries', () => {
    const block = fixture(), text = 'alpha beta gamma delta\nother words last words';
    const value = paragraphPresentation(block, text, style, 1, text => text.length * 10);
    expect(value.fallbacks).toEqual([undefined, undefined]);
    const root = document.createElement('div'); root.dataset.pdfParagraphEditor = 'true'; root.innerHTML = value.html;
    document.body.append(root);
    expect(root.querySelectorAll('[data-pdf-source-row]')).toHaveLength(4);
    expect(serializeRichText(root, style).text).toBe(text);
    expect(serializeRichText(root, style).paragraphs).toHaveLength(2);
    expect(value.html).toContain('word-spacing:var(--pdf-word-space,-10px)');
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
    expect(row.style.wordSpacing).toContain('20px');
    root.querySelector<HTMLElement>('[data-pdf-measured-paragraph]')!.dataset.pdfFlowing = 'true';
    const saved = row.style.wordSpacing;
    recalibrateParagraphRows(root, style, 2, text => text.length * 5);
    expect(row.style.wordSpacing).toBe(saved);
    expect(root.textContent).toBe(before);
  });
});
