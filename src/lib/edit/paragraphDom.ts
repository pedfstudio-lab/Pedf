import type { TextParagraphLayout } from '@/lib/export/types';

export const ZERO_PARAGRAPH: TextParagraphLayout = { gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 };
export function readParagraphLayout(element: HTMLElement): TextParagraphLayout {
  const number = (key: string) => Math.max(0, Number(element.dataset[key]) || 0);
  return { gapBeforePt: number('gapBeforePt'), firstIndentPt: number('firstIndentPt'), restIndentPt: number('restIndentPt') };
}
export function hasRootParagraphText(root: HTMLElement): boolean {
  return [...root.childNodes].some(node => node.nodeType === 3 ? !!node.textContent
    : node instanceof HTMLElement && !node.matches('[data-pdf-paragraph]')
      && !node.querySelector('[data-pdf-paragraph]') && !!node.textContent);
}
/** A line break inside a paragraph: same block, so no gap and no first-line indent. */
export function continuationParagraph(layout: TextParagraphLayout | undefined): TextParagraphLayout {
  return layout ? { gapBeforePt: 0, firstIndentPt: layout.restIndentPt, restIndentPt: layout.restIndentPt } : ZERO_PARAGRAPH;
}
/** One layout per text line, always: a saved edit whose counts differ cannot be reopened. */
export function alignParagraphLayouts(text: string, layouts: readonly TextParagraphLayout[]): TextParagraphLayout[] {
  const count = text.replace(/\r\n?/g, '\n').split('\n').length;
  const aligned = layouts.slice(0, count);
  while (aligned.length < count) aligned.push(continuationParagraph(aligned.at(-1)));
  return aligned;
}
/**
 * Does a `<br>` start a new visible line? Browsers draw no extra line for a break
 * that ends its block, which is exactly the placeholder Chrome puts in an empty
 * paragraph — often inside a copied style span, not directly in the paragraph.
 */
export function breakStartsLine(br: Element, root: HTMLElement): boolean {
  const paragraph = br.parentElement?.closest('[data-pdf-paragraph]');
  const scope = paragraph && root.contains(paragraph) ? paragraph : root;
  const walker = root.ownerDocument.createTreeWalker(scope, 0x1 | 0x4);
  walker.currentNode = br;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) { if (node.nodeValue) return true; continue; }
    const element = node as Element;
    if (element.hasAttribute('data-pdf-paragraph')) return false;
    if (element.tagName === 'BR') return true;
  }
  return false;
}
export function paragraphGapPreset(layouts: readonly TextParagraphLayout[]): number {
  const counts = new Map<number, number>();
  for (const layout of layouts.slice(1)) {
    const gap = Math.round(layout.gapBeforePt * 2) / 2; counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
}

/** Attributes only: never rewrite text or move a live selection/composition. */
export function normalizeParagraphDom(root: HTMLElement, cache: Map<string, TextParagraphLayout>, preset: number, zoom: number): void {
  const blocks = [...root.querySelectorAll<HTMLElement>('div,p')];
  const seen = new Set<string>();
  let previous = ZERO_PARAGRAPH;
  const rootText = hasRootParagraphText(root);
  blocks.forEach((element, index) => {
    let id = element.dataset.paragraphId;
    let layout = id && !seen.has(id) ? cache.get(id) : undefined;
    if (!layout) {
      id = `new-${cache.size}`;
      layout = { ...previous, gapBeforePt: preset };
      cache.set(id, layout);
    }
    seen.add(id!);
    const current = index === 0 && !rootText ? { ...layout, gapBeforePt: 0 } : layout;
    element.dataset.pdfParagraph = 'true'; element.dataset.paragraphId = id;
    element.dataset.gapBeforePt = String(current.gapBeforePt);
    element.dataset.firstIndentPt = String(current.firstIndentPt);
    element.dataset.restIndentPt = String(current.restIndentPt);
    element.style.marginTop = `${current.gapBeforePt * zoom}px`;
    element.style.paddingLeft = `${current.restIndentPt * zoom}px`;
    element.style.textIndent = `${(current.firstIndentPt - current.restIndentPt) * zoom}px`;
    const parent = element.parentElement?.closest<HTMLElement>('[data-pdf-paragraph]');
    element.style.marginLeft = parent ? `${-readParagraphLayout(parent).restIndentPt * zoom}px` : '0px';
    previous = current;
  });
}

function activeRange(root: HTMLElement): Range | undefined {
  const selection = root.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  return range && root.contains(range.commonAncestorContainer) ? range : undefined;
}
function selectRange(root: HTMLElement, range: Range): void {
  const selection = root.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}
function paragraphOf(node: Node, root: HTMLElement): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const paragraph = element?.closest<HTMLElement>('[data-pdf-paragraph]');
  return paragraph && root.contains(paragraph) ? paragraph : undefined;
}

/**
 * The selection cut at every paragraph edge, in document order. Wrapping one
 * whole cross-paragraph range in a span would pull paragraph blocks inside it.
 */
export function paragraphSelectionRanges(root: HTMLElement, range: Range): Range[] {
  if (!root.querySelector('[data-pdf-paragraph]')) return [range];
  const units: Node[] = [];
  const collect = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      const element = child instanceof HTMLElement ? child : undefined;
      if (element?.matches('[data-pdf-paragraph]') && !element.querySelector('[data-pdf-paragraph]')) units.push(element);
      else if (element?.querySelector('[data-pdf-paragraph]')) collect(element);
      else units.push(child);
    }
  };
  collect(root);
  return units.flatMap((unit) => {
    const bounds = root.ownerDocument.createRange();
    bounds.selectNodeContents(unit);
    const clipped = root.ownerDocument.createRange();
    if (range.compareBoundaryPoints(Range.START_TO_START, bounds) >= 0) clipped.setStart(range.startContainer, range.startOffset);
    else clipped.setStart(bounds.startContainer, bounds.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, bounds) <= 0) clipped.setEnd(range.endContainer, range.endOffset);
    else clipped.setEnd(bounds.endContainer, bounds.endOffset);
    return !clipped.collapsed && clipped.toString() !== '' ? [clipped] : [];
  });
}

/** Native transactions preserve the browser's typing/undo stack. Fallback is for DOM-only tests. */
export function insertParagraphBreak(root: HTMLElement): boolean {
  if (typeof root.ownerDocument.execCommand === 'function' && root.ownerDocument.execCommand('insertParagraph', false)) return true;
  const range = activeRange(root), left = range && paragraphOf(range.startContainer, root), right = range && paragraphOf(range.endContainer, root);
  if (!range || !left || !right) return false;
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-pdf-paragraph]')];
  const tail = root.ownerDocument.createRange(); tail.selectNodeContents(right); tail.setStart(range.endContainer, range.endOffset);
  const suffix = tail.extractContents(); range.deleteContents();
  for (const block of blocks.slice(blocks.indexOf(left) + 1, blocks.indexOf(right) + 1)) block.remove();
  const next = left.cloneNode(false) as HTMLElement; next.append(suffix);
  if (!next.hasChildNodes()) next.append(root.ownerDocument.createElement('br'));
  if (!left.hasChildNodes()) left.append(root.ownerDocument.createElement('br'));
  left.after(next);
  range.selectNodeContents(next); range.collapse(true); selectRange(root, range);
  return true;
}

export function insertParagraphText(root: HTMLElement, text: string): boolean {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (typeof root.ownerDocument.execCommand === 'function' && root.ownerDocument.execCommand('insertText', false, normalized)) return true;
  const parts = normalized.split('\n');
  for (const [index, part] of parts.entries()) {
    if (index && !insertParagraphBreak(root)) return false;
    const range = activeRange(root); if (!range) return false;
    range.deleteContents();
    const node = root.ownerDocument.createTextNode(part); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selectRange(root, range);
  }
  return true;
}

/** Browser Backspace remains native; this fallback gives jsdom the same merge semantics. */
export function mergeParagraphBackward(root: HTMLElement): boolean {
  const range = activeRange(root), current = range && paragraphOf(range.startContainer, root);
  if (!range?.collapsed || !current) return false;
  const before = root.ownerDocument.createRange(); before.selectNodeContents(current); before.setEnd(range.startContainer, range.startOffset);
  if (before.toString()) return false;
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-pdf-paragraph]')], previous = blocks[blocks.indexOf(current) - 1];
  if (!previous) return false;
  if (previous.childNodes.length === 1 && previous.firstChild?.nodeName === 'BR') previous.firstChild.remove();
  const offset = previous.childNodes.length; previous.append(...current.childNodes); current.remove();
  range.setStart(previous, offset); range.collapse(true); selectRange(root, range); return true;
}
