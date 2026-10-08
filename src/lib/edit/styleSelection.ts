import { paragraphSelectionRanges } from './paragraphDom';

export type ClearedStyleProperty = 'fontSize' | 'fontFamily' | 'color';

/** Wrap the selected text in styled spans and select exactly what was wrapped. */
export function wrapSelectionWithStyle(
  root: HTMLElement,
  range: Range,
  styles: Record<string, string>,
  data: Record<string, string>,
  clearedProperties: readonly ClearedStyleProperty[],
): Range {
  // One wrapper per paragraph: a single span around several paragraph blocks
  // would split them (extractContents clones each partly selected block).
  const pieces = paragraphSelectionRanges(root, range);
  if (pieces.length === 0) return range;
  const document = root.ownerDocument;
  const wrappers = [...pieces].reverse()
    .map((piece) => wrapRangeWithStyle(piece, styles, data, clearedProperties)).reverse();
  const selected = document.createRange();
  selected.setStart(wrappers[0]!, 0);
  selected.setEnd(wrappers.at(-1)!, wrappers.at(-1)!.childNodes.length);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(selected);
  return selected;
}

function wrapRangeWithStyle(
  range: Range,
  styles: Record<string, string>,
  data: Record<string, string>,
  clearedProperties: readonly ClearedStyleProperty[],
): HTMLElement {
  const fragment = range.extractContents();
  const wrapper = range.startContainer.ownerDocument!.createElement('span');
  for (const [property, value] of Object.entries(styles)) {
    (wrapper.style as unknown as Record<string, string>)[property] = value;
  }
  for (const [name, value] of Object.entries(data)) wrapper.dataset[name] = value;
  for (const descendant of Array.from(fragment.querySelectorAll<HTMLElement>('*'))) {
    for (const property of clearedProperties) descendant.style[property] = '';
    if (clearedProperties.includes('fontSize')) delete descendant.dataset.fontSizePt;
    if (clearedProperties.includes('fontFamily')) {
      delete descendant.dataset.fontName;
      delete descendant.dataset.fontRef;
      delete descendant.dataset.sourceBold;
      delete descendant.dataset.sourceStrokeBold;
    }
    if (clearedProperties.includes('color')) {
      delete descendant.dataset.textColor;
      delete descendant.dataset.colorKnown;
    }
  }
  wrapper.append(fragment);
  range.insertNode(wrapper);
  return wrapper;
}
