import type { TextEdit, TextSpan, TextStyle } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import { composeTextLine, sourceLineComposition } from './lineComposition';
import { sourceParagraphs } from './paragraphSeed';
import { effectiveTextSpans, effectiveTextSpanStyle, richTextToHtml, serializeRichText, sourceSpansForTextBlock, splitParagraphSpans } from './richText';
import type { WrappedTextLine } from './textLayout';
import type { MeasurePiece } from './lineComposition';
import { isIndicRun } from '@/lib/export/scriptRouting';
import { visibleWordSpacingFloor } from './justifiedLayout';

export interface ParagraphPresentation {
  readonly html: string;
  readonly lines: readonly (readonly WrappedTextLine[])[];
  readonly fallbacks: readonly (string | undefined)[];
}

/** Match saved rows to their logical paragraphs without guessing changed letters. */
function savedParagraphs(text: string, edits: readonly TextEdit[]): TextEdit[][] | undefined {
  let cursor = 0;
  const groups: TextEdit[][] = [];
  for (const part of text.split('\n')) {
    const group: TextEdit[] = []; let offset = 0;
    while (cursor < edits.length) {
      const edit = edits[cursor]!, start = part.indexOf(edit.text, offset);
      if (start < offset || /\S/u.test(part.slice(offset, start))) return undefined;
      group.push(edit); offset = start + edit.text.length; cursor++;
      if (offset === part.length) break;
    }
    if (offset !== part.length) return undefined;
    groups.push(group);
  }
  return cursor === edits.length ? groups : undefined;
}

/** Only presentation attributes change while typing. Native text nodes stay put. */
export function flowSelectedParagraphs(root: HTMLElement): void {
  const selection = root.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (!range || !root.contains(range.commonAncestorContainer)) return;
  for (const paragraph of root.querySelectorAll<HTMLElement>('[data-pdf-measured-paragraph]')) {
    if (range.intersectsNode(paragraph)) setFlow(paragraph, true);
  }
}

function setFlow(paragraph: HTMLElement, flowing: boolean): void {
  paragraph.dataset.pdfFlowing = String(flowing);
  for (const [key, value] of [['--pdf-row-display', 'inline'], ['--pdf-row-space', 'normal'], ['--pdf-row-indent', '0px'], ['--pdf-piece-gap', '0px'], ['--pdf-word-space', '0px']] as const) {
    if (flowing) paragraph.style.setProperty(key, value); else paragraph.style.removeProperty(key);
  }
}

function spansUpTo(spans: readonly TextSpan[], length: number): TextSpan[] {
  let left = length;
  return spans.flatMap(span => {
    const text = span.text.slice(0, Math.max(0, left)); left -= text.length;
    return text ? [{ ...span, text }] : [];
  });
}

/** Font loading may change advances; recalibrate presentation, never PDF positions. */
export function recalibrateParagraphRows(root: HTMLElement, style: TextStyle, zoom: number, measure: MeasurePiece): void {
  for (const paragraph of root.querySelectorAll<HTMLElement>('[data-pdf-measured-paragraph]')) {
    if (paragraph.dataset.pdfFlowing === 'true') continue;
    for (const row of paragraph.querySelectorAll<HTMLElement>('[data-pdf-source-row]')) {
      // A row's trailing space joins it to the next row and takes no room on screen.
      const value = serializeRichText(row, style, zoom), text = value.text.replace(/\s+$/u, '');
      const spans = value.spans ? spansUpTo(value.spans, text.length) : undefined;
      const spaces = (text.match(/\s/gu) ?? []).length;
      if (!spaces) continue;
      const width = effectiveTextSpans(text, value.style, spans).reduce((sum, span) => sum + measure(span.text, effectiveTextSpanStyle(value.style, span)), 0);
      const target = Number(row.dataset.pdfSourceWidthPt);
      const spacing = (target - width) / spaces;
      // Old edits keep their stored row presentation; the new safety rule is
      // for newly extracted PDF text, not a migration of saved layouts.
      const floor = paragraph.dataset.pdfSavedRows === 'true' ? -Infinity
        : visibleWordSpacingFloor(effectiveTextSpans(text,value.style,spans),value.style,(word,span)=>measure(word,effectiveTextSpanStyle(value.style,span)));
      if (spacing < floor - 1e-6) {
        paragraph.dataset.pdfGapReflow = 'true';
        setFlow(paragraph,true);
        break;
      }
      row.style.wordSpacing = `var(--pdf-word-space,${Math.max(spacing,floor) * zoom}px)`;
    }
  }
}

export function snapshotParagraphs(root: HTMLElement, style: TextStyle, zoom: number): ReadonlyMap<string, string> {
  return new Map([...root.querySelectorAll<HTMLElement>('[data-pdf-measured-paragraph]')].map(element => [element.dataset.paragraphId!, JSON.stringify(serializeRichText(element, style, zoom))]));
}

/** Undo/backspace can restore the original appearance without rewriting the DOM. */
export function refreshParagraphPresentation(root: HTMLElement, initial: ReadonlyMap<string, string>, style: TextStyle, zoom: number): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-pdf-paragraph]')) {
    if (!element.hasAttribute('data-pdf-measured-paragraph') && element.querySelector('[data-pdf-source-row]')) element.dataset.pdfMeasuredParagraph = 'true';
    if (!element.hasAttribute('data-pdf-measured-paragraph')) continue;
    setFlow(element, element.dataset.pdfGapReflow === 'true' || JSON.stringify(serializeRichText(element, style, zoom)) !== initial.get(element.dataset.paragraphId!));
  }
}

export function paragraphPresentation(block: TextBlock, text: string, style: TextStyle, zoom: number, measure: MeasurePiece, existing?: readonly TextEdit[]): ParagraphPresentation {
  const original = sourceParagraphs(block), saved = existing?.length ? savedParagraphs(text, existing) : undefined;
  const groups = saved ?? (existing?.length ? [] : original.lines);
  const layouts = existing?.[0]?.boxParagraphs ?? original.layouts;
  const lines: WrappedTextLine[][] = [], fallbacks: (string | undefined)[] = [];
  const parts = text.split('\n');
  const paragraphSpans = splitParagraphSpans(existing?.[0]?.boxSpans ?? sourceSpansForTextBlock(block, text, true) ?? []);
  const html = parts.map((part, paragraphIndex) => {
    const group = groups[paragraphIndex], layout = layouts[paragraphIndex];
    const rowModels = group?.map(row => {
      const raw = 'kind' in row ? row.composition : sourceLineComposition(row);
      const composition = raw ? { ...raw, style } : undefined;
      const spans = 'kind' in row ? row.spans : sourceSpansForTextBlock({ ...block, text: row.text, lines: [row] }, row.text, true);
      return { text: row.text, spans, sourcePosition: 'kind' in row ? { x: row.rect.x, y: row.rect.y, width: row.rect.w }
        : { x: row.rect.x, y: row.metrics?.baselineY ?? row.baselineY, width: row.rect.w }, sourceComposition: composition };
    }) ?? [];
    lines.push(rowModels);
    let reason = !group?.length || rowModels.map(row => row.text).join(' ') !== part ? 'source-paragraph-text-unmatched'
      : isIndicRun(part) ? 'indic-path-a' : undefined;
    for (const row of rowModels) {
      const composed = composeTextLine(row.sourceComposition, row.text, row.sourceComposition?.style ?? style, measure);
      if ('reason' in composed) reason ??= composed.reason;
      if (!existing?.length) {
        const spans = effectiveTextSpans(row.text,style,row.spans), spaces = (row.text.match(/\s/gu) ?? []).length;
        const natural = spans.reduce((sum,span)=>sum+measure(span.text,effectiveTextSpanStyle(style,span)),0);
        const floor = visibleWordSpacingFloor(spans,style,(word,span)=>measure(word,effectiveTextSpanStyle(style,span)));
        if (spaces && (row.sourcePosition.width-natural)/spaces < floor-1e-6) reason ??= 'word-gap-below-readable-minimum';
      }
    }
    fallbacks.push(reason);
    const body = reason ? richTextToHtml(part, style, paragraphSpans[paragraphIndex]?.length ? paragraphSpans[paragraphIndex] : undefined, zoom)
      : rowModels.map((row, rowIndex) => {
        const spans = effectiveTextSpans(row.text, style, row.spans);
        const naturalWidth = spans.reduce((sum, span) => sum + measure(span.text, effectiveTextSpanStyle(style, span)), 0);
        const spaces = (row.text.match(/\s/gu) ?? []).length;
        const wordSpacing = spaces ? (row.sourcePosition.width - naturalWidth) / spaces : 0;
        const content = richTextToHtml(row.text, style, row.spans, zoom);
        const offset = row.sourcePosition.x - (existing?.[0]?.boxLeftPt ?? block.rect.x) - (layout?.restIndentPt ?? 0);
        // The space joining two rows ends the row before it. Between two block rows, inside the
        // editor's pre-wrap text, a space of its own would be a blank line; at the end of a
        // nowrap row it takes no room, and it still separates the words once the paragraph flows.
        const separator = rowIndex < rowModels.length - 1 ? ' ' : '';
        return `<span data-pdf-source-row="true" data-pdf-source-width-pt="${row.sourcePosition.width}" style="display:var(--pdf-row-display,block);white-space:var(--pdf-row-space,nowrap);text-indent:0;word-spacing:var(--pdf-word-space,${wordSpacing * zoom}px);margin-left:var(--pdf-row-indent,${offset * zoom}px)">${content}${separator}</span>`;
      }).join('');
    return `<div data-pdf-paragraph="true" data-paragraph-id="source-${paragraphIndex}"${existing?.length ? ' data-pdf-saved-rows="true"' : ''}${reason ? ` data-pdf-paragraph-fallback="${reason}"` : ' data-pdf-measured-paragraph="true"'}${layout?.minimumWordGapEm !== undefined ? ` data-minimum-word-gap-em="${layout.minimumWordGapEm}"` : ''} data-gap-before-pt="${layout?.gapBeforePt ?? 0}" data-first-indent-pt="${layout?.firstIndentPt ?? 0}" data-rest-indent-pt="${layout?.restIndentPt ?? 0}" style="margin-top:${(paragraphIndex ? layout?.gapBeforePt ?? 0 : 0) * zoom}px;padding-left:${(layout?.restIndentPt ?? 0) * zoom}px;text-indent:${((layout?.firstIndentPt ?? 0) - (layout?.restIndentPt ?? 0)) * zoom}px">${body || '<br>'}</div>`;
  }).join('');
  return { html, lines, fallbacks };
}
