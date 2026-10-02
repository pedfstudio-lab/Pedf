import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { PdfRect, Rgb, TextEdit, TextStyle } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { ScreenRect } from '@/lib/export/coordinates';
import { textBlockLineHeight } from '@/lib/edit/buildTextEdits';
import type { NextTextEdit } from '@/lib/edit/buildTextEdits';
import {
  calculateBulletRoomPt,
  calculateInitialEditorWidth,
  finishTextEdit,
  sameTextEditSession,
} from '@/lib/edit/textEditSession';
import type { TextEditSessionValue } from '@/lib/edit/textEditSession';
import { textStyleToCanvasFont, textStyleToCss } from '@/lib/edit/textStyleCss';
import { editorFirstLineOffsetPx } from '@/lib/edit/editorPosition';
import { classifyFontFamily } from '@/lib/pdf/textContent';
import {
  effectiveTextSpanStyle,
  richTextToHtml,
  serializeRichText,
  sourceSpansForTextBlock,
} from '@/lib/edit/richText';
import {
  SNAP_THRESHOLD_PX,
  snapAxis,
} from '@/lib/edit/moveSnap';
import type { MoveGuideState, SnapTarget } from '@/lib/edit/moveSnap';
import { BULLET_NO_ROOM_MESSAGE, formatBulletEditorText } from '@/lib/pdf/bulletList';
import { toolbarOffsetInFrame, useElementSize } from '@/lib/edit/floatingToolbar';
import type { ElementSize } from '@/lib/edit/floatingToolbar';
import {
  editorWidthMeasurementText,
  listSeedText,
  paragraphSeedText,
  widestLineWidth,
} from '@/lib/edit/paragraphSeed';
import { neighbourBoxWidth } from '@/lib/edit/neighbourBoxWidth';
import { startsWithBulletMarker } from '@/lib/pdf/textUnits';
import { FontSizeCombobox } from './FontSizeCombobox';

const FAMILY_KEYWORD = {
  sans: 'Arial',
  serif: 'Times New Roman',
  mono: 'Courier New',
} as const;
type FamilyKey = keyof typeof FAMILY_KEYWORD;

const MIN_BOX_WIDTH = 12;
const MIN_BOX_HEIGHT = 8;
const COMMON_TEXT_COLORS: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 1, g: 1, b: 1 },
  { r: 0.35, g: 0.35, b: 0.35 },
  { r: 0.75, g: 0.75, b: 0.75 },
  { r: 0.85, g: 0.1, b: 0.1 },
  { r: 0.95, g: 0.55, b: 0.05 },
  { r: 0.1, g: 0.55, b: 0.2 },
  { r: 0.1, g: 0.35, b: 0.85 },
];

function colorCss(color: Rgb): string {
  return `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
}

function colorHex(color: Rgb): string {
  const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function hexColor(value: string): Rgb | undefined {
  const match = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!match) return undefined;
  return {
    r: Number.parseInt(match[1] ?? '00', 16) / 255,
    g: Number.parseInt(match[2] ?? '00', 16) / 255,
    b: Number.parseInt(match[3] ?? '00', 16) / 255,
  };
}

function computedColor(value: string): Rgb | undefined {
  const match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!match) return undefined;
  return {
    r: Number(match[1]) / 255,
    g: Number(match[2]) / 255,
    b: Number(match[3]) / 255,
  };
}

function sameRgb(left?: Rgb, right?: Rgb): boolean {
  return left?.r === right?.r && left?.g === right?.g && left?.b === right?.b;
}

function sameAppearanceMetadata(
  initial: TextEditSessionValue,
  current: TextEditSessionValue,
): boolean {
  if (
    initial.style.sourceBold !== current.style.sourceBold ||
    initial.style.sourceStrokeBold !== current.style.sourceStrokeBold ||
    initial.style.colorKnown !== current.style.colorKnown
  ) return false;
  if (!initial.spans || !current.spans) return initial.spans === current.spans;
  return initial.spans.length === current.spans.length && initial.spans.every((span, index) => {
    const other = current.spans?.[index];
    return Boolean(
      other &&
      span.sourceBold === other.sourceBold &&
      span.sourceStrokeBold === other.sourceStrokeBold &&
      span.colorKnown === other.colorKnown &&
      sameRgb(span.color, other.color)
    );
  });
}

function selectionRangeInside(root: HTMLElement): Range | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : undefined;
}

function placeCaretAtEnd(root: HTMLElement): void {
  let lastNode: Node = root;
  while (lastNode.lastChild) lastNode = lastNode.lastChild;
  const range = window.document.createRange();
  if (lastNode.nodeType === Node.TEXT_NODE) {
    range.setStart(lastNode, lastNode.textContent?.length ?? 0);
  } else {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function insertPlainText(root: HTMLElement, text: string): boolean {
  const range = selectionRangeInside(root);
  const selection = window.getSelection();
  if (!range || !selection) return false;
  range.deleteContents();
  const node = window.document.createTextNode(text.replace(/\r\n?/g, '\n'));
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function markerPrefixAtLineEnd(
  root: HTMLElement,
  style: TextStyle,
  zoom: number,
): string | undefined {
  const caret = selectionRangeInside(root);
  if (!caret?.collapsed) return undefined;

  const beforeCaret = window.document.createRange();
  beforeCaret.selectNodeContents(root);
  beforeCaret.setEnd(caret.startContainer, caret.startOffset);
  const wrapper = window.document.createElement('div');
  wrapper.append(beforeCaret.cloneContents());
  const prefixText = serializeRichText(wrapper, style, zoom).text;
  const fullText = serializeRichText(root, style, zoom).text;
  const nextBreak = fullText.indexOf('\n', prefixText.length);
  const lineEnd = nextBreak < 0 ? fullText.length : nextBreak;
  if (prefixText.length !== lineEnd) return undefined;

  const lineStart = prefixText.lastIndexOf('\n') + 1;
  const line = prefixText.slice(lineStart);
  if (!startsWithBulletMarker(line)) return undefined;
  const leadingSpace = line.match(/^\s*/u)?.[0] ?? '';
  const afterLeadingSpace = line.slice(leadingSpace.length);
  const marker = Array.from(afterLeadingSpace)[0];
  if (!marker) return undefined;
  const afterMarker = afterLeadingSpace.slice(marker.length);
  const markerSpace = afterMarker.match(/^\s*/u)?.[0] ?? '';
  return `${leadingSpace}${marker}${markerSpace}`;
}

function elementAtRangeStart(range: Range, root: HTMLElement): HTMLElement {
  const node = range.startContainer;
  if (node.nodeType === Node.ELEMENT_NODE) return node as HTMLElement;
  return node.parentElement ?? root;
}

function selectWrappedRange(wrapper: HTMLElement): Range {
  const range = window.document.createRange();
  range.selectNodeContents(wrapper);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function wrapSelectionWithStyle(
  range: Range,
  styles: Record<string, string>,
  data: Record<string, string>,
  clearedProperties: readonly ('fontSize' | 'fontFamily' | 'color')[],
): Range {
  const fragment = range.extractContents();
  const wrapper = window.document.createElement('span');
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
  return selectWrappedRange(wrapper);
}

function measureWidestInitialLine(
  text: string,
  style: TextStyle,
  measure?: (line: string) => number,
): number {
  if (measure) return widestLineWidth(text, measure);
  const canvas = window.document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return 0;
  context.font = textStyleToCanvasFont(style);
  return widestLineWidth(text, (line) => context.measureText(line).width);
}

function savedTextBoxRect(texts: readonly TextEdit[]): PdfRect {
  const first = texts[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...texts.map((edit) => edit.rect.x));
  const right = Math.max(...texts.map((edit) => edit.rect.x + edit.rect.w));
  const top = Math.max(...texts.map((edit) => edit.rect.y + edit.rect.h));
  const bottom = Math.min(...texts.map((edit) => edit.rect.y));
  const height = first.boxHeight ?? top - bottom;
  return {
    x: first.boxLeftPt ?? left,
    y: top - height,
    w: first.boxWidthPt ?? right - left,
    h: height,
  };
}

function savedEditingRect(
  texts: readonly TextEdit[],
  block: TextBlock,
  align: TextEdit['align'],
  alignLeftPt: number,
  alignWidthPt: number,
): PdfRect {
  const saved = savedTextBoxRect(texts);
  if (align === 'left') return saved;
  const storesOnlyAlignmentRegion = Math.abs(saved.x - alignLeftPt) <= 0.01
    && Math.abs(saved.w - alignWidthPt) <= 0.01
    && alignWidthPt >= block.rect.w - 0.01;
  if (!storesOnlyAlignmentRegion) return saved;

  // Existing aligned edits store the full alignment region in rect. Recover the
  // visible text rectangle without changing that persisted/exported geometry.
  const sourceAlignLeftPt = block.alignLeftPt ?? block.rect.x;
  return {
    x: block.rect.x + alignLeftPt - sourceAlignLeftPt,
    y: saved.y,
    w: block.rect.w,
    h: saved.h,
  };
}

interface TextEditOverlayProps {
  readonly block: TextBlock;
  readonly blocks?: readonly TextBlock[];
  readonly existing?: readonly TextEdit[];
  readonly screenRect: ScreenRect;
  /** Box-only source-ink adjustment; content cancels it to retain the PDF baseline. */
  readonly topCorrectionPx?: number;
  readonly zoom: number;
  readonly pageWidthPt: number;
  /** Page box in CSS pixels; floating bars are kept inside it because the page clips overflow. */
  readonly pageSizePx: ElementSize;
  readonly backgroundColor: string;
  readonly previewMode?: 'legacy' | 'preparing' | 'clean';
  readonly committing?: boolean;
  readonly verticalTargets: readonly SnapTarget[];
  readonly horizontalTargets: readonly SnapTarget[];
  readonly bulletMode?: {
    readonly items: readonly string[];
    readonly maxHeightPt: number;
  };
  /** Test seam for deterministic line-width measurements; production uses canvas. */
  readonly measureTextWidth?: (line: string) => number;
  readonly externalError?: string;
  onMoveStateChange(state: MoveGuideState | null): void;
  onDone(next: NextTextEdit): void;
  onCancel(): void;
}

export function TextEditOverlay({
  block,
  blocks = [],
  existing,
  screenRect,
  topCorrectionPx = 0,
  zoom,
  pageWidthPt,
  pageSizePx,
  backgroundColor,
  previewMode = 'legacy',
  committing = false,
  verticalTargets,
  horizontalTargets,
  bulletMode,
  measureTextWidth,
  externalError,
  onMoveStateChange,
  onDone,
  onCancel,
}: TextEditOverlayProps) {
  const markerList = !bulletMode
    && block.lines.some((line) => startsWithBulletMarker(line.text));
  const initialText = existing?.[0]?.boxText ??
    (bulletMode ? formatBulletEditorText(bulletMode.items) : undefined) ??
    existing?.map((edit) => edit.text).join('\n') ??
    ((block.align ?? 'left') === 'left'
      ? (markerList ? listSeedText(block) : paragraphSeedText(block))
      : block.text);
  // Re-opening a bullet list must seed its font from a body line, not the "•" marker
  // (whose style deliberately drops fontRef); recover a lost fontRef from the block so a
  // list damaged by an earlier re-edit heals its embedded font on the next edit.
  const initialStyle = (() => {
    if (!bulletMode) return existing?.[0]?.style ?? block.style;
    const body = existing?.find((edit) => edit.text !== '•')?.style ?? block.style;
    return body.fontRef ? body : { ...body, fontRef: block.style.fontRef };
  })();
  const initialSpans = existing?.[0]?.boxSpans
    ?? (existing?.length === 1 ? existing[0]?.spans : undefined)
    ?? sourceSpansForTextBlock(block, initialText);
  const initialAlign = bulletMode ? 'left' : (existing?.[0]?.align ?? block.align ?? 'left');
  const initialAlignLeftPt = existing?.[0]?.alignLeftPt ?? block.alignLeftPt ?? block.rect.x;
  const initialAlignWidthPt = existing?.[0]?.alignWidthPt ?? block.alignWidthPt ?? block.rect.w;
  const usesAlignmentColumn = initialAlign !== 'left';
  const editingRect = existing?.length
    ? savedEditingRect(existing, block, initialAlign, initialAlignLeftPt, initialAlignWidthPt)
    : block.rect;
  const alignmentBox = neighbourBoxWidth({
    pageIndex: block.pageIndex,
    rect: editingRect,
    align: initialAlign,
    alignLeftPt: initialAlignLeftPt,
    alignWidthPt: initialAlignWidthPt,
  }, blocks.filter((candidate) => candidate !== block));
  const savedLineCount = existing?.length
    ? Math.max(existing.length, initialText.split('\n').length)
    : 0;
  const preservesDisplayLines = usesAlignmentColumn && (
    existing?.length ? savedLineCount > 1 : block.lines.length > 1
  );
  const boxLeftPt = preservesDisplayLines ? editingRect.x : alignmentBox.left;
  const boxWidthPt = preservesDisplayLines ? editingRect.w : alignmentBox.width;
  // screenRect starts at the committed alignment region. Move only the visible box.
  const boxScreenLeft = screenRect.left + (usesAlignmentColumn
    ? (boxLeftPt - initialAlignLeftPt) * zoom : 0);
  const initialHtmlRef = useRef(richTextToHtml(initialText, initialStyle, initialSpans, zoom));
  const [style, setStyle] = useState<TextStyle>(initialStyle);
  const [selectionStyle, setSelectionStyle] = useState({
    bold: initialStyle.bold,
    italic: initialStyle.italic,
    fontSizePt: initialStyle.fontSizePt,
    family: classifyFontFamily(initialStyle.fontName) as FamilyKey,
    color: initialStyle.colorKnown === false ? undefined : initialStyle.color as Rgb | undefined,
    colorKnown: initialStyle.colorKnown !== false,
  });
  const [colorPanelOpen, setColorPanelOpen] = useState(false);
  const [appearanceError, setAppearanceError] = useState<string>();
  const naturalWidth = usesAlignmentColumn ? initialAlignWidthPt : block.rect.w;
  const widthMeasurementText = editorWidthMeasurementText(block, existing);
  const [initialWidth] = useState(() => bulletMode
    ? Math.max(naturalWidth, existing?.[0]?.rect.w ?? 0)
    : usesAlignmentColumn
      ? Math.max(MIN_BOX_WIDTH, boxWidthPt)
      : calculateInitialEditorWidth({
        blockWidthPt: naturalWidth,
        blockXPt: block.rect.x,
        existingWidthPt: existing?.[0]?.rect.w,
        fontSizePt: initialStyle.fontSizePt,
        measuredLineWidthPt: measureWidestInitialLine(
          widthMeasurementText,
          initialStyle,
          measureTextWidth,
        ),
        pageWidthPt,
      }));
  const initialHeight = Math.max(existing?.[0]?.boxHeight ?? block.rect.h, MIN_BOX_HEIGHT);
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState(initialHeight);
  const [moveOffset, setMoveOffset] = useState({ x: 0, y: 0 });
  const [toolbarRef, toolbarSize] = useElementSize<HTMLDivElement>();
  const [errorRef, errorSize] = useElementSize<HTMLDivElement>();
  const editableRef = useRef<HTMLDivElement>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const initialRenderedHeightRef = useRef(initialHeight);
  const capturedInitialHeightRef = useRef(false);
  const initializedRef = useRef(false);
  const composingRef = useRef(false);

  const beginWidthDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    event.currentTarget.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      setWidth(Math.max(MIN_BOX_WIDTH, startWidth + (moveEvent.clientX - startX) / zoom));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  const beginMoveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = moveOffset;
    event.currentTarget.setPointerCapture(event.pointerId);
    onMoveStateChange({
      crosshair: {
        x: boxScreenLeft + startOffset.x,
        y: screenRect.top + startOffset.y,
      },
    });

    const move = (moveEvent: PointerEvent) => {
      const rawOffset = {
        x: startOffset.x + moveEvent.clientX - startX,
        y: startOffset.y + moveEvent.clientY - startY,
      };
      const rawLeft = boxScreenLeft + rawOffset.x;
      const rawTop = screenRect.top + rawOffset.y;
      const boxWidth = width * zoom;
      const boxHeight = height * zoom;
      const xSnap = snapAxis(
        rawLeft,
        rawLeft + boxWidth / 2,
        rawLeft + boxWidth,
        verticalTargets,
        SNAP_THRESHOLD_PX,
      );
      const ySnap = snapAxis(
        rawTop,
        rawTop + boxHeight / 2,
        rawTop + boxHeight,
        horizontalTargets,
        SNAP_THRESHOLD_PX,
      );
      const snappedOffset = {
        x: rawOffset.x + (xSnap?.delta ?? 0),
        y: rawOffset.y + (ySnap?.delta ?? 0),
      };
      setMoveOffset(snappedOffset);
      onMoveStateChange({
        crosshair: {
          x: boxScreenLeft + snappedOffset.x,
          y: screenRect.top + snappedOffset.y,
        },
        ...(xSnap ? { vertical: xSnap.guide } : {}),
        ...(ySnap ? { horizontal: ySnap.guide } : {}),
      });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      onMoveStateChange(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  const bulletRoomPt = bulletMode
    ? calculateBulletRoomPt(bulletMode.maxHeightPt, moveOffset.y, zoom)
    : Number.POSITIVE_INFINITY;
  const bulletOverflow = Boolean(bulletMode && height > bulletRoomPt + 0.5);

  const commit = () => {
    if (committing || composingRef.current) return;
    const editable = editableRef.current;
    if (!editable) return;
    const serialized = serializeRichText(editable, style, zoom);
    const next: NextTextEdit = {
      text: serialized.text,
      style: serialized.style,
      ...(serialized.spans ? { spans: serialized.spans } : {}),
      width,
      height,
      dx: moveOffset.x / zoom,
      dy: -moveOffset.y / zoom,
      boxLeftPt: boxLeftPt + moveOffset.x / zoom,
      boxWidthPt: width,
      ...(usesAlignmentColumn ? {
        align: initialAlign,
        alignLeftPt: initialAlignLeftPt,
        alignWidthPt: initialAlignWidthPt,
      } : {}),
    };
    if (bulletOverflow) return;
    const initial = {
        text: initialText,
        style: initialStyle,
        ...(initialSpans ? { spans: initialSpans } : {}),
        width: initialWidth,
        height: initialRenderedHeightRef.current,
        dx: 0,
        dy: 0,
        ...(usesAlignmentColumn ? {
          align: initialAlign,
          alignLeftPt: initialAlignLeftPt,
          alignWidthPt: initialAlignWidthPt,
        } : {}),
      };
    const sessionUnchanged = sameTextEditSession(initial, next);
    const appearanceUnchanged = sameAppearanceMetadata(initial, next);
    const unknownColor = serialized.style.colorKnown === false || serialized.spans?.some((span) => (
      effectiveTextSpanStyle(serialized.style, span).colorKnown === false
    ));
    if (unknownColor && (!sessionUnchanged || !appearanceUnchanged)) {
      setAppearanceError('Choose a text colour before finishing this edit.');
      return;
    }
    setAppearanceError(undefined);
    if (sessionUnchanged && !appearanceUnchanged) {
      onDone(next);
      return;
    }
    finishTextEdit(initial, next, onDone, onCancel);
  };
  const editorFrame: ScreenRect = {
    left: boxScreenLeft + moveOffset.x,
    top: screenRect.top + moveOffset.y,
    width: width * zoom,
    height: height * zoom,
  };
  // The formatting bar and the error note are kept inside the page box (Task 56 Rev 2).
  const toolbarOffset = toolbarOffsetInFrame(editorFrame, toolbarSize, pageSizePx, 8);
  const errorOffset = {
    left: toolbarOffsetInFrame(editorFrame, errorSize, pageSizePx, 8).left,
    top: editorFrame.height + 8,
  };
  // A right or centre box now starts where its neighbour ends, so a handle hanging
  // outside that corner would sit back on the neighbour's words. Keep it inside, where
  // such a box always has empty room before its own text.
  const moveHandleOffset = usesAlignmentColumn ? { left: 0, top: 0 } : { left: -12, top: -12 };
  const lineHeight = textBlockLineHeight(block, style);
  const firstLineOffsetPx = editorFirstLineOffsetPx(lineHeight, style.fontSizePt, zoom) - topCorrectionPx;
  const visibleError = externalError
    ?? appearanceError
    ?? (bulletOverflow ? BULLET_NO_ROOM_MESSAGE : undefined);
  const resizeToContent = useCallback(() => {
    const editable = editableRef.current;
    if (!editable) return;
    editable.style.height = '0px';
    const contentHeight = Math.max(lineHeight * zoom, editable.scrollHeight);
    editable.style.height = `${contentHeight}px`;
    const nextHeight = contentHeight / zoom;
    if (!capturedInitialHeightRef.current) {
      initialRenderedHeightRef.current = nextHeight;
      capturedInitialHeightRef.current = true;
    }
    setHeight(nextHeight);
  }, [lineHeight, zoom]);

  useLayoutEffect(() => {
    const editable = editableRef.current;
    if (!editable) return;
    if (!initializedRef.current) {
      editable.innerHTML = initialHtmlRef.current;
      initializedRef.current = true;
      editable.focus({ preventScroll: true });
      placeCaretAtEnd(editable);
    }
    resizeToContent();
  }, [resizeToContent, width]);

  const refreshSelectionStyle = useCallback(() => {
    const editable = editableRef.current;
    const range = editable ? selectionRangeInside(editable) : undefined;
    if (!editable || !range) return;
    selectionRangeRef.current = range.cloneRange();
    const bold = window.document.queryCommandState('bold');
    const italic = window.document.queryCommandState('italic');
    const selectedElement = elementAtRangeStart(range, editable);
    const computed = window.getComputedStyle(selectedElement);
    const fontSizePt = Number.parseFloat(computed.fontSize) / zoom || style.fontSizePt;
    const family = classifyFontFamily(computed.fontFamily) as FamilyKey;
    const explicitUnknown = selectedElement.closest('[data-color-known="false"]');
    const explicitKnown = selectedElement.closest('[data-text-color], [data-color-known="true"]');
    const colorKnown = explicitUnknown ? false : explicitKnown ? true : style.colorKnown !== false;
    const color = colorKnown ? (computedColor(computed.color) ?? style.color) : undefined;
    setSelectionStyle((current) => (
      current.bold === bold &&
      current.italic === italic &&
      current.fontSizePt === fontSizePt &&
      current.family === family &&
      current.colorKnown === colorKnown &&
      current.color?.r === color?.r &&
      current.color?.g === color?.g &&
      current.color?.b === color?.b
        ? current
        : { bold, italic, fontSizePt, family, color, colorKnown }
    ));
  }, [style.color, style.colorKnown, style.fontSizePt, zoom]);

  useEffect(() => {
    window.document.addEventListener('selectionchange', refreshSelectionStyle);
    return () => window.document.removeEventListener('selectionchange', refreshSelectionStyle);
  }, [refreshSelectionStyle]);

  useEffect(() => () => onMoveStateChange(null), [onMoveStateChange]);

  const applyInlineStyle = (command: 'bold' | 'italic') => {
    const editable = editableRef.current;
    if (!editable) return;
    let range = selectionRangeInside(editable);
    if (!range) {
      const savedRange = selectionRangeRef.current;
      if (!savedRange || !editable.contains(savedRange.commonAncestorContainer)) return;
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(savedRange.cloneRange());
      range = savedRange;
    }
    if (range.collapsed) {
      const nextValue = !selectionStyle[command];
      setStyle((value) => ({ ...value, [command]: nextValue }));
      setSelectionStyle((value) => ({ ...value, [command]: nextValue }));
      editable.focus({ preventScroll: true });
      return;
    }
    window.document.execCommand(command, false);
    refreshSelectionStyle();
    resizeToContent();
  };

  const editableRange = (): Range | undefined => {
    const editable = editableRef.current;
    if (!editable) return undefined;
    const current = selectionRangeInside(editable);
    const range = current ?? selectionRangeRef.current?.cloneRange();
    if (!range || !editable.contains(range.commonAncestorContainer)) return undefined;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range;
  };

  const applyFontSize = (fontSizePt: number) => {
    const editable = editableRef.current;
    const range = editableRange();
    if (!editable || !range || range.collapsed) {
      setStyle((value) => ({ ...value, fontSizePt }));
      setSelectionStyle((value) => ({ ...value, fontSizePt }));
      editable?.focus({ preventScroll: true });
      resizeToContent();
      window.requestAnimationFrame(() => {
        refreshSelectionStyle();
        resizeToContent();
      });
      return;
    }
    const selected = wrapSelectionWithStyle(
      range,
      { fontSize: `${fontSizePt * zoom}px` },
      { fontSizePt: String(fontSizePt) },
      ['fontSize'],
    );
    selectionRangeRef.current = selected.cloneRange();
    editable.focus({ preventScroll: true });
    refreshSelectionStyle();
    resizeToContent();
  };

  const changeFontFamily = (family: FamilyKey) => {
    const editable = editableRef.current;
    const range = editableRange();
    const fontName = FAMILY_KEYWORD[family];
    if (!editable || !range || range.collapsed) {
      setStyle((value) => ({
        ...value,
        fontName,
        fontRef: undefined,
        sourceBold: undefined,
        sourceStrokeBold: undefined,
      }));
      setSelectionStyle((value) => ({ ...value, family }));
      return;
    }
    const selected = wrapSelectionWithStyle(
      range,
      { fontFamily: fontName },
      { fontName },
      ['fontFamily'],
    );
    selectionRangeRef.current = selected.cloneRange();
    refreshSelectionStyle();
    resizeToContent();
  };

  const applyTextColor = (color: Rgb) => {
    const editable = editableRef.current;
    const range = editableRange();
    setAppearanceError(undefined);
    if (!editable || !range || range.collapsed) {
      setStyle((value) => ({ ...value, color, colorKnown: true }));
      setSelectionStyle((value) => ({ ...value, color, colorKnown: true }));
      setColorPanelOpen(false);
      editable?.focus({ preventScroll: true });
      return;
    }
    const selected = wrapSelectionWithStyle(
      range,
      { color: colorCss(color) },
      { textColor: `${color.r},${color.g},${color.b}`, colorKnown: 'true' },
      ['color'],
    );
    selectionRangeRef.current = selected.cloneRange();
    editable.focus({ preventScroll: true });
    setSelectionStyle((value) => ({ ...value, color, colorKnown: true }));
    setColorPanelOpen(false);
    refreshSelectionStyle();
  };

  const pastePlainText = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const editable = editableRef.current;
    if (!editable) return;
    event.preventDefault();
    insertPlainText(editable, event.clipboardData.getData('text/plain'));
    resizeToContent();
  };

  return (
    <div
      className="absolute isolate z-50"
      onPointerDownCapture={(event) => { if (committing) {event.preventDefault();event.stopPropagation();} }}
      onClickCapture={(event) => { if (committing) {event.preventDefault();event.stopPropagation();} }}
      onKeyDownCapture={(event) => { if (committing) {event.preventDefault();event.stopPropagation();} }}
      style={{
        left: boxScreenLeft + moveOffset.x,
        top: screenRect.top + moveOffset.y,
        width: width * zoom,
        height: height * zoom,
        backgroundColor: previewMode === 'legacy' ? backgroundColor : 'transparent',
      }}
    >
      <div
        ref={toolbarRef}
        className="absolute z-20 flex items-center gap-1 rounded-lg border border-neutral-300 bg-white p-1 shadow-xl"
        style={toolbarOffset}
        role="toolbar"
        aria-label="Text formatting"
        aria-busy={committing || previewMode === 'preparing'}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && colorPanelOpen) {
            event.preventDefault();
            event.stopPropagation();
            setColorPanelOpen(false);
            editableRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        {bulletMode && (
          <span className="whitespace-nowrap px-1 text-xs font-semibold text-amber-700">Bullet list</span>
        )}
        <FontSizeCombobox value={selectionStyle.fontSizePt} onApply={applyFontSize} />
        <button type="button" aria-pressed={selectionStyle.bold} onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={() => applyInlineStyle('bold')} className={`rounded px-2 py-1 text-sm font-bold ${selectionStyle.bold ? 'bg-blue-100 text-blue-800' : 'hover:bg-neutral-100'}`}>B</button>
        <button type="button" aria-pressed={selectionStyle.italic} onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={() => applyInlineStyle('italic')} className={`rounded px-2 py-1 text-sm italic ${selectionStyle.italic ? 'bg-blue-100 text-blue-800' : 'hover:bg-neutral-100'}`}>I</button>
        <select
          aria-label="Font family"
          value={selectionStyle.family}
          onChange={(event) => {
            changeFontFamily(event.target.value as FamilyKey);
          }}
          className="rounded border border-neutral-200 bg-white px-1 py-1 text-sm"
        >
          <option value="sans">Sans</option>
          <option value="serif">Serif</option>
          <option value="mono">Mono</option>
        </select>
        <div className="relative">
          <button
            type="button"
            aria-label="Text colour"
            aria-expanded={colorPanelOpen}
            title={selectionStyle.colorKnown ? 'Text colour' : 'Source colour could not be decoded'}
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setColorPanelOpen((open) => !open)}
            className={`flex h-7 w-8 items-center justify-center rounded border ${
              selectionStyle.colorKnown ? 'border-neutral-300' : 'border-dashed border-amber-500'
            }`}
          >
            <span
              aria-hidden="true"
              className="flex h-4 w-4 items-center justify-center rounded-sm border border-black/20 text-[10px] font-bold"
              style={{ backgroundColor: selectionStyle.color ? colorCss(selectionStyle.color) : 'white' }}
            >
              {selectionStyle.colorKnown ? '' : '?'}
            </span>
          </button>
          {colorPanelOpen && (
            <div
              role="dialog"
              aria-label="Choose text colour"
              className="absolute left-0 top-9 z-40 w-44 rounded-lg border border-neutral-300 bg-white p-2 shadow-xl"
            >
              <div className="grid grid-cols-4 gap-1">
                {COMMON_TEXT_COLORS.map((color) => (
                  <button
                    key={colorHex(color)}
                    type="button"
                    aria-label={`Use ${colorHex(color)} text colour`}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applyTextColor(color)}
                    className="h-7 rounded border border-neutral-300"
                    style={{ backgroundColor: colorCss(color) }}
                  />
                ))}
              </div>
              <label className="mt-2 flex items-center justify-between gap-2 text-xs text-neutral-700">
                Custom
                <input
                  aria-label="Custom text colour"
                  type="color"
                  value={colorHex(selectionStyle.color ?? style.color)}
                  onChange={(event) => {
                    const color = hexColor(event.target.value);
                    if (color) applyTextColor(color);
                  }}
                  className="h-7 w-12 cursor-pointer rounded border border-neutral-300 bg-white p-0.5"
                />
              </label>
            </div>
          )}
        </div>
        <span className="mx-1 h-5 w-px bg-neutral-200" />
        {previewMode === 'preparing' && <span role="status" className="whitespace-nowrap px-1 text-xs text-neutral-500">Preparing text…</span>}
        <button type="button" disabled={committing} onClick={onCancel} className="rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100">Cancel</button>
        <button
          type="button"
          data-text-edit-done
          onClick={commit}
          disabled={bulletOverflow || committing}
          className="rounded bg-neutral-900 px-2 py-1 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
        >
          Done
        </button>
      </div>

      {visibleError && (
        <div
          ref={errorRef}
          role="alert"
          className="absolute z-30 whitespace-nowrap rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 shadow"
          style={errorOffset}
        >
          {visibleError}
        </div>
      )}

      <div
        ref={editableRef}
        role="textbox"
        aria-label={bulletMode ? 'Editable bullet list' : 'Editable text'}
        aria-multiline="true"
        contentEditable={!committing}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={resizeToContent}
        onCompositionStart={()=>{composingRef.current=true;}}
        onCompositionEnd={()=>{composingRef.current=false;resizeToContent();}}
        onPaste={pastePlainText}
        onKeyDown={(event) => {
          if (committing || event.nativeEvent.isComposing) return;
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const editable = editableRef.current;
            if (editable) {
              const markerPrefix = markerList
                ? markerPrefixAtLineEnd(editable, style, zoom)
                : undefined;
              insertPlainText(editable, bulletMode ? '\n• ' : `\n${markerPrefix ?? ''}`);
            }
            resizeToContent();
          }
        }}
        className="relative z-0 block w-full overflow-hidden whitespace-pre-wrap break-words rounded-sm border-0 bg-transparent p-0 outline outline-2 outline-blue-500"
        style={{
          ...textStyleToCss(style, zoom),
          ...(previewMode === 'preparing' ? {WebkitTextFillColor:'transparent',caretColor:colorCss(style.color)} : {}),
          lineHeight: lineHeight / style.fontSizePt,
          top: firstLineOffsetPx,
          textAlign: initialAlign,
        }}
      />
      <button
        type="button"
        aria-label="Drag to change text width"
        onPointerDown={beginWidthDrag}
        className="absolute -right-2 top-0 z-10 h-full w-4 cursor-ew-resize rounded bg-blue-500/80 hover:bg-blue-600"
      />
      <button
        type="button"
        aria-label="Drag to move"
        title="Drag to move; arrow keys move one pixel"
        onPointerDown={beginMoveDrag}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          const delta = {
            ArrowLeft: { x: -step, y: 0 },
            ArrowRight: { x: step, y: 0 },
            ArrowUp: { x: 0, y: -step },
            ArrowDown: { x: 0, y: step },
          }[event.key];
          if (!delta) return;
          event.preventDefault();
          setMoveOffset((value) => ({ x: value.x + delta.x, y: value.y + delta.y }));
        }}
        style={moveHandleOffset}
        className="absolute z-20 h-6 w-6 cursor-move rounded-full border-2 border-white bg-blue-600 text-xs font-bold leading-none text-white shadow hover:bg-blue-700"
      >
        ✥
      </button>
    </div>
  );
}
