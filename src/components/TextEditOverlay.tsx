import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { PdfRect, Rgb, TextEdit, TextStyle, PositionedTextPiece, TextParagraphLayout } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { ScreenRect } from '@/lib/export/coordinates';
import { textBlockLineHeight } from '@/lib/edit/buildTextEdits';
import type { FontMetrics, NextTextEdit } from '@/lib/edit/buildTextEdits';
import {
  calculateBulletRoomPt,
  calculateInitialEditorWidth,
  finishTextEdit,
  sameTextEditSession,
} from '@/lib/edit/textEditSession';
import type { TextEditSessionValue } from '@/lib/edit/textEditSession';
import { measureMatchedText, textFontFamily, textStyleToCanvasFont, textStyleToCss } from '@/lib/edit/textStyleCss';
import { ensureMatchedFont } from '@/lib/fonts/twinFonts';
import { canUseSourceWord } from '@/lib/fonts/fontMatch';
import { fallbackWordRanges, overlapsFallback } from '@/lib/fonts/wordFonts';
import { baselineCorrectionPx, editorFirstLineOffsetPx } from '@/lib/edit/editorPosition';
import { classifyFontFamily } from '@/lib/pdf/textContent';
import {
  effectiveTextSpanStyle,
  elementTextStyle,
  richTextToHtml,
  serializeRichText,
  sourceSpansForTextBlock,
  splitParagraphSpans,
} from '@/lib/edit/richText';
import {
  SNAP_THRESHOLD_PX,
  snapAxis,
} from '@/lib/edit/moveSnap';
import type { MoveGuideState, SnapTarget } from '@/lib/edit/moveSnap';
import { BULLET_NO_ROOM_MESSAGE, formatBulletEditorText } from '@/lib/pdf/bulletList';
import { toolbarOffsetInFrame, useElementSize } from '@/lib/edit/floatingToolbar';
import { indicEditMessage } from '@/lib/translate/indicText';
import type { ElementSize } from '@/lib/edit/floatingToolbar';
import {
  editorWidthMeasurementText,
  listSeedText,
  paragraphSeedText,
  sourceParagraphs,
  widestLineWidth,
} from '@/lib/edit/paragraphSeed';
import { neighbourBoxWidth } from '@/lib/edit/neighbourBoxWidth';
import { startsWithBulletMarker } from '@/lib/pdf/textUnits';
import {
  hasRootParagraphText, insertParagraphBreak, insertParagraphText, mergeParagraphBackward, normalizeParagraphDom,
  paragraphGapPreset,
} from '@/lib/edit/paragraphDom';
import { wrapSelectionWithStyle } from '@/lib/edit/styleSelection';
import { FontSizeCombobox } from './FontSizeCombobox';
import { composeTextLine, compositionWidth, sourceLineComposition } from '@/lib/edit/lineComposition';
import { flowSelectedParagraphs, paragraphPresentation, recalibrateParagraphRows, refreshParagraphPresentation, snapshotParagraphs } from '@/lib/edit/paragraphPresentation';
import { wrapTextParagraphs } from '@/lib/edit/paragraphLayout';
import { minimumWordSpacing } from '@/lib/edit/justifiedLayout';
import { hasLetterSpacedHeading } from '@/lib/edit/letterSpacedHeading';
import { effectiveTextSpans } from '@/lib/edit/richText';
import { readParagraphLayout } from '@/lib/edit/paragraphDom';
import { bulletEditorHtml, canonicalBulletValue, insertBulletItems, refreshBulletEditorLayout } from '@/lib/edit/bulletEditorPresentation';
import { cornerDragFactor, scaleTextBox } from '@/lib/edit/scaleTextBox';

/** Widths are measured at 1 PDF point per CSS pixel, independent of zoom/layout. */
function measurePieceWithCanvas(text: string, style: TextStyle, source?: PositionedTextPiece): number {
  const context = window.document.createElement('canvas').getContext('2d');
  if (!context) return NaN;
  const measure = (value: string) => measureMatchedText(context, value, style);
  const width = measure(text);
  if (source?.advanceTrackingPt !== undefined) return width + [...text].length * source.advanceTrackingPt;
  if (source?.advanceScale !== undefined) return width * source.advanceScale;
  if (!source || (source.source && !source.source.glyphs?.length)) return width;
  const intrinsicWidth = source.source?.glyphs?.reduce((sum, glyph) => sum + glyph.widthPt, 0) ?? source.widthPt;
  const originalWidth = measure(source.text);
  return originalWidth > 0 ? width * intrinsicWidth / originalWidth : width;
}

function canvasWidth(text: string, style: TextStyle): number {
  return measurePieceWithCanvas(text, style);
}

/** Face metrics, not DOM positions: mixed-size CSS line boxes use this face. */
function measureFontMetrics(style: TextStyle, zoom: number): FontMetrics | undefined {
  const context = window.document.createElement('canvas').getContext('2d');
  if (!context) return undefined;
  const size = style.fontSizePt * zoom;
  context.font = textStyleToCanvasFont({ ...style, fontSizePt: size });
  const metrics = context.measureText('M');
  const ascent = metrics.fontBoundingBoxAscent / size, descent = metrics.fontBoundingBoxDescent / size;
  return Number.isFinite(ascent) && Number.isFinite(descent) && ascent > 0 && descent >= 0 ? { ascent, descent } : undefined;
}

const FAMILY_KEYWORD = {
  sans: 'Arial',
  serif: 'Times New Roman',
  mono: 'Courier New',
} as const;
type FamilyKey = keyof typeof FAMILY_KEYWORD;

const MIN_BOX_WIDTH = 12;
const MIN_BOX_HEIGHT = 8;
const EMPTY_FRAME_WIDTH_PX = 24;

/** Text-node ranges avoid the full-width rectangles of block-level DOM wrappers. */
function liveTextFrame(
  editable: HTMLElement,
  origin: DOMRect,
  zoom: number,
  lineHeightPx: number,
): ScreenRect | undefined {
  const range = editable.ownerDocument.createRange();
  // jsdom has no layout; the browser always provides these APIs.
  if (typeof range.getClientRects !== 'function') return undefined;
  const walker = editable.ownerDocument.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  const rectangles: DOMRect[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.length) continue;
    range.selectNodeContents(node);
    rectangles.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
  }
  if (rectangles.length > 0) {
    const left = Math.min(...rectangles.map((rect) => rect.left));
    const top = Math.min(...rectangles.map((rect) => rect.top));
    const right = Math.max(...rectangles.map((rect) => rect.right));
    const bottom = Math.max(...rectangles.map((rect) => rect.bottom));
    const padding = zoom;
    return {
      left: left - origin.left - padding,
      top: top - origin.top - padding,
      width: right - left + padding * 2,
      height: bottom - top + padding * 2,
    };
  }
  // An empty editor retains a usable frame at its caret. No temporary glyph is
  // inserted: that would disturb native selection or an in-progress composition.
  const caret = selectionRangeInside(editable);
  if (caret?.collapsed) range.setStart(caret.startContainer, caret.startOffset);
  else { range.selectNodeContents(editable); range.collapse(true); }
  range.collapse(true);
  const caretRect = Array.from(range.getClientRects()).find((rect) => rect.height > 0);
  const anchor = editable.getBoundingClientRect();
  const align = window.getComputedStyle(editable).textAlign;
  const caretLeft = caretRect?.left ?? (align === 'center'
    ? anchor.left + anchor.width / 2
    : align === 'right' ? anchor.right : anchor.left);
  const minimumWidth = EMPTY_FRAME_WIDTH_PX * zoom;
  return {
    left: caretLeft - origin.left - (align === 'center' ? minimumWidth / 2 : align === 'right' ? minimumWidth : 0),
    top: (caretRect?.top ?? anchor.top) - origin.top,
    width: minimumWidth,
    height: lineHeightPx,
  };
}
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
  requireLineEnd = true,
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
  if (requireLineEnd && prefixText.length !== lineEnd) return undefined;

  const lineStart = prefixText.lastIndexOf('\n') + 1;
  const line = requireLineEnd ? prefixText.slice(lineStart) : fullText.slice(lineStart, lineEnd);
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
  return widestLineWidth(text, (line) => measureMatchedText(context,line,style));
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
  if (align === 'left' || align === 'justify') return saved;
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
  /** Page CSS y-coordinate of the first baseline used by Done, before a drag. */
  readonly expectedBaselinePx?: number;
  /** Add Text's existing font-size-dependent baseline, converted through the viewport. */
  readonly baselineFontSizeSlopePx?: number;
  readonly zoom: number;
  readonly pageWidthPt: number;
  /** Page box in CSS pixels; floating bars are kept inside it because the page clips overflow. */
  readonly pageSizePx: ElementSize;
  /** Rotation-aware page text rectangles, used only to keep the below-toolbar clear. */
  readonly toolbarObstacles?: readonly ScreenRect[];
  readonly backgroundColor: string;
  readonly previewMode?: 'legacy' | 'preparing' | 'clean';
  readonly committing?: boolean;
  readonly verticalTargets: readonly SnapTarget[];
  readonly horizontalTargets: readonly SnapTarget[];
  readonly bulletMode?: {
    readonly items: readonly string[];
    readonly symbols?: readonly string[];
    readonly maxHeightPt: number;
    readonly indentPt?: number;
    readonly itemSpacingPt?: number;
  };
  /** Test seam for deterministic line-width measurements; production uses canvas. */
  readonly measureTextWidth?: (line: string) => number;
  readonly externalError?: string;
  /** Date ordinals retain their relative size when the whole date's size changes. */
  readonly scaleInlineSizes?: boolean;
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
  expectedBaselinePx,
  baselineFontSizeSlopePx = 0,
  zoom,
  pageWidthPt,
  pageSizePx,
  toolbarObstacles = [],
  backgroundColor,
  previewMode = 'legacy',
  committing = false,
  verticalTargets,
  horizontalTargets,
  bulletMode,
  measureTextWidth,
  externalError,
  scaleInlineSizes = false,
  onMoveStateChange,
  onDone,
  onCancel,
}: TextEditOverlayProps) {
  const markerList = !bulletMode
    && block.lines.some((line) => startsWithBulletMarker(line.text));
  const measuredHeading = !bulletMode && !markerList
    && hasLetterSpacedHeading(block)
    && (!existing?.length || existing.every(edit => edit.composition));
  const initialText = existing?.[0]?.boxText ??
    (bulletMode ? formatBulletEditorText(bulletMode.items, bulletMode.symbols) : undefined) ??
    existing?.map((edit) => edit.text).join('\n') ??
    (measuredHeading ? block.text : ((block.align ?? 'left') === 'left' || block.align === 'justify')
      ? (markerList ? listSeedText(block) : paragraphSeedText(block))
      : block.text);
  // Re-opening a bullet list must seed its font from a body line, not the "•" marker
  // (whose style deliberately drops fontRef); recover a lost fontRef from the block so a
  // list damaged by an earlier re-edit heals its embedded font on the next edit.
  const initialStyle = (() => {
    if (!bulletMode) return existing?.[0]?.style ?? block.style;
    const body = existing?.find((edit) => edit.text !== '•' && edit.text !== '➢')?.style ?? block.style;
    return body.fontRef ? body : { ...body, fontRef: block.style.fontRef };
  })();
  const initialSpans = existing?.[0]?.boxSpans
    ?? (existing?.length === 1 ? existing[0]?.spans : undefined)
    ?? sourceSpansForTextBlock(block, initialText);
  const initialAlign = bulletMode ? 'left' : existing?.length ? existing[0]?.align ?? 'left' : block.align ?? 'left';
  const initialAlignLeftPt = existing?.[0]?.alignLeftPt ?? block.alignLeftPt ?? block.rect.x;
  const initialAlignWidthPt = existing?.[0]?.alignWidthPt ?? block.alignWidthPt ?? block.rect.w;
  const usesAlignmentColumn = initialAlign === 'center' || initialAlign === 'right';
  const paragraphMode = !bulletMode && !markerList && !measuredHeading && !usesAlignmentColumn
    && (existing?.length ? existing[0]?.boxParagraphs !== undefined : block.lines.length > 0);
  const initialParagraphs = paragraphMode ? existing?.[0]?.boxParagraphs ?? sourceParagraphs(block).layouts : undefined;
  const paragraphCacheRef = useRef(new Map<string, TextParagraphLayout>(initialParagraphs?.map((layout, index) => [`source-${index}`, layout] as const) ?? []));
  const paragraphGap = paragraphGapPreset(initialParagraphs ?? []);
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
  const initialCompositions = !bulletMode && !markerList && !paragraphMode
    ? existing?.length ? existing.map(edit => edit.composition) : block.lines.map(line => sourceLineComposition(line, initialAlign, initialAlignLeftPt, initialAlignWidthPt)) : [];
  const sourceCompositionsRef = useRef(initialCompositions.map(composition => composition ? { ...composition, style: initialStyle, pieces: composition.pieces.map(piece => {
    const natural = canvasWidth(piece.text, piece.style);
    return natural > 0 ? initialCompositions.length > 1 || composition.pieces.length > 1
      ? { ...piece, advanceTrackingPt: (piece.widthPt - natural) / Math.max(1, [...piece.text].length) }
      : { ...piece, advanceScale: piece.widthPt / natural } : piece;
  }) } : undefined));
  const initialComposition = sourceCompositionsRef.current[0];
  const [paragraphPresentationModel] = useState(() => paragraphMode && block.lines.length > 1
    ? paragraphPresentation(block, initialText, initialStyle, zoom, measureTextWidth ?? measurePieceWithCanvas, existing) : undefined);
  const paragraphPresentationRef = useRef(paragraphPresentationModel);
  const paragraphSnapshotsRef = useRef<ReadonlyMap<string, string>>(new Map());
  const compositionRef = useRef(initialComposition);
  const [compositionPreviewActive, setCompositionPreviewActive] = useState(Boolean(initialComposition));
  const [initialScaleX] = useState(() => {
    const piece = initialCompositions.length === 1 && initialComposition?.pieces.length === 1 ? initialComposition.pieces[0] : undefined;
    const natural = piece ? canvasWidth(piece.text, piece.style) : 0;
    return piece && natural > 0 ? piece.widthPt / natural : 1;
  });
  const initialHtmlRef = useRef((() => {
    if (bulletMode?.indentPt !== undefined) return bulletEditorHtml(initialText,initialStyle,initialSpans,zoom,bulletMode.indentPt);
    if (paragraphPresentationRef.current) return paragraphPresentationRef.current.html;
    if (!initialComposition || sourceCompositionsRef.current.some(composition => !composition)
      || (initialCompositions.length === 1 && initialComposition.pieces.length < 2)) return richTextToHtml(initialText, initialStyle, initialSpans, zoom, initialParagraphs);
    return sourceCompositionsRef.current.map((composition, lineIndex) => {
      if (!composition) return '';
      let cursor = 0;
      const content = composition.pieces.map((piece, index) => {
      const start = composition.text.indexOf(piece.text, cursor), separator = composition.text.slice(cursor, start);
      cursor = start + piece.text.length;
      const previous = composition.pieces[index - 1];
      const gap = previous ? piece.x - previous.x - previous.widthPt - canvasWidth(separator, initialStyle) : 0;
      const tracking = piece.advanceTrackingPt ?? 0;
      const html = richTextToHtml(piece.text, initialStyle, [{ text: piece.text, ...piece.style }], zoom);
      const baseTracking = (piece.style.fontTrackingEm ?? 0) * piece.style.fontSizePt * zoom;
      return richTextToHtml(separator, initialStyle) + `<span data-pdf-source-line="${lineIndex}" data-pdf-source-piece="${index}" style="margin-left:${gap * zoom}px"><span data-pdf-piece-content="true" style="--pdf-piece-tracking:${tracking * zoom}px;letter-spacing:calc(var(--pdf-piece-tracking,0px) + ${baseTracking}px)">${html}</span></span>`;
      }).join('') + richTextToHtml(composition.text.slice(cursor), initialStyle);
      const layout = initialParagraphs?.[lineIndex];
      const paragraphAttributes = layout ? ` data-pdf-paragraph="true" data-paragraph-id="source-${lineIndex}" data-gap-before-pt="${layout.gapBeforePt}" data-first-indent-pt="${layout.firstIndentPt}" data-rest-indent-pt="${layout.restIndentPt}" style="margin-top:${layout.gapBeforePt * zoom}px;padding-left:${layout.restIndentPt * zoom}px;text-indent:${(layout.firstIndentPt - layout.restIndentPt) * zoom}px"` : '';
      return initialCompositions.length > 1 ? `<div data-pdf-composition-line="${lineIndex}"${paragraphAttributes}>${content}</div>` : content;
    }).join('');
  })());
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
  const [scriptError, setScriptError] = useState(() => indicEditMessage(initialText));
  const naturalWidth = usesAlignmentColumn ? initialAlignWidthPt : block.rect.w;
  const widthMeasurementText = editorWidthMeasurementText(block, existing);
  const measuredHeadingWidth = measuredHeading && !existing?.length ? neighbourBoxWidth({
    pageIndex: block.pageIndex, rect: editingRect, align: 'right', alignLeftPt: editingRect.x,
    alignWidthPt: Math.max(editingRect.w, pageWidthPt - editingRect.x - Math.max(2, initialStyle.fontSizePt * 0.25)),
  }, blocks.filter(candidate => candidate !== block)).width : 0;
  const [initialWidth] = useState(() => bulletMode
    ? Math.max(naturalWidth, existing?.[0]?.rect.w ?? 0)
    : usesAlignmentColumn
      ? Math.max(MIN_BOX_WIDTH, boxWidthPt)
      : Math.max(measuredHeadingWidth, calculateInitialEditorWidth({
        blockWidthPt: naturalWidth,
        ...(paragraphMode && (block.lines.length > 1 || (existing?.length ?? 0) > 1) ? {
          paragraphColumnWidthPt: existing?.[0]?.boxWidthPt ?? existing?.[0]?.rect.w ?? block.rect.w,
        } : {}),
        blockXPt: block.rect.x,
        existingWidthPt: existing?.[0]?.rect.w,
        fontSizePt: initialStyle.fontSizePt,
        measuredLineWidthPt: measureWidestInitialLine(
          widthMeasurementText,
          initialStyle,
          measureTextWidth,
        ),
        pageWidthPt,
      })));
  const initialHeight = Math.max(existing?.[0]?.boxHeight ?? block.rect.h, MIN_BOX_HEIGHT);
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState(initialHeight);
  const [moveOffset, setMoveOffset] = useState({ x: 0, y: 0 });
  const [toolbarRef, toolbarSize] = useElementSize<HTMLDivElement>();
  const [errorRef, errorSize] = useElementSize<HTMLDivElement>();
  const editableRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const baselineProbeRef = useRef<HTMLDivElement>(null);
  const baselineMarkerRef = useRef<HTMLSpanElement>(null);
  const baselineSampleRef = useRef<HTMLSpanElement>(null);
  const [measuredBaselineOffset, setMeasuredBaselineOffset] = useState<number>();
  const [inkFrame, setInkFrame] = useState<ScreenRect>();
  const selectionRangeRef = useRef<Range | null>(null);
  const initialRenderedHeightRef = useRef(initialHeight);
  const capturedInitialHeightRef = useRef(false);
  const initializedRef = useRef(false);
  const composingRef = useRef(false);
  const initialPresentedValueRef = useRef<ReturnType<typeof serializeRichText>>();
  const stopCornerDragRef = useRef<(() => void) | undefined>();
  useEffect(() => () => stopCornerDragRef.current?.(), []);

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
    const raw = serializeRichText(editable, style, zoom);
    const serialized = bulletMode ? canonicalBulletValue(raw) : raw;
    const invalidScript = indicEditMessage(serialized.text);
    setScriptError(invalidScript);
    if (invalidScript) return;
    const fontMetrics = paragraphMode ? measureFontMetrics(style, zoom) : undefined;
    const next: NextTextEdit = {
      text: serialized.text,
      style: serialized.style,
      ...(serialized.spans ? { spans: serialized.spans } : {}),
      ...(paragraphMode ? { paragraphs: serialized.paragraphs } : {}),
      ...(fontMetrics ? { fontMetrics } : {}),
      ...(paragraphPresentationRef.current ? { sourceParagraphLines: paragraphPresentationRef.current.lines } : {}),
      ...(!bulletMode && !markerList && block.lines.length ? {
        ...(compositionRef.current ? { sourceCompositions: sourceCompositionsRef.current }
          : existing?.length ? { sourceCompositions: existing.map(edit => edit.composition) } : {}),
        measurePiece: measureTextWidth ?? measurePieceWithCanvas,
      } : {}),
      ...(paragraphMode && !existing?.length && width === initialWidth ? { preserveSourceWrapping: true } : {}),
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
      ...(initialAlign === 'justify' || (existing?.length && block.align === 'justify') ? { align: initialAlign } : {}),
    };
    if (bulletOverflow) return;
    const presented = initialPresentedValueRef.current;
    const initial = {
        text: presented ? presented.text : initialText,
        style: presented ? presented.style : initialStyle,
        ...((presented ? presented.spans : initialSpans) ? { spans: presented ? presented.spans : initialSpans } : {}),
        ...((presented ? presented.paragraphs : initialParagraphs) ? { paragraphs: presented ? presented.paragraphs : initialParagraphs } : {}),
        width: initialWidth,
        height: initialRenderedHeightRef.current,
        dx: 0,
        dy: 0,
        ...(usesAlignmentColumn ? {
          align: initialAlign,
          alignLeftPt: initialAlignLeftPt,
          alignWidthPt: initialAlignWidthPt,
        } : {}),
        ...(initialAlign === 'justify' || (existing?.length && block.align === 'justify') ? { align: initialAlign } : {}),
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
  const layoutFrame: ScreenRect = {
    left: boxScreenLeft + moveOffset.x,
    top: screenRect.top + moveOffset.y,
    width: width * zoom,
    height: height * zoom,
  };
  const visualFrame = inkFrame ?? { left: 0, top: 0, width: EMPTY_FRAME_WIDTH_PX * zoom, height: style.fontSizePt * zoom };
  const editorFrame: ScreenRect = {
    left: layoutFrame.left + visualFrame.left,
    top: layoutFrame.top + visualFrame.top,
    width: visualFrame.width,
    height: visualFrame.height,
  };
  // The formatting bar and the error note are kept inside the page box (Task 56 Rev 2).
  let toolbarFrame = editorFrame;
  let placedToolbar = toolbarOffsetInFrame(toolbarFrame, toolbarSize, pageSizePx, 8);
  // Near the page top, putting the bar immediately below a heading can hide its
  // subtitle. Extend only the placement input past intersecting neighbour text;
  // the existing helper still owns above/below choice and page-edge clamping.
  if (editorFrame.top < toolbarSize.height + 8 && toolbarSize.height > 0) {
    const left = toolbarFrame.left + placedToolbar.left;
    const top = toolbarFrame.top + placedToolbar.top;
    const collisions = toolbarObstacles.filter((rect) => (
      rect.top + rect.height > editorFrame.top + editorFrame.height &&
      rect.left < left + toolbarSize.width && rect.left + rect.width > left &&
      rect.top < top + toolbarSize.height && rect.top + rect.height > top
    ));
    if (collisions.length) {
      // Clear the immediately neighbouring row (e.g. the subtitle), not every
      // subsequent paragraph: a dense page otherwise sends the bar to its foot.
      const nearestTop = Math.min(...collisions.map((rect) => rect.top));
      const bottom = Math.max(...collisions.filter((rect) => rect.top <= nearestTop + 2 * zoom)
        .map((rect) => rect.top + rect.height));
      // A dense page may have no free slot. Keep the page-contained fallback,
      // rather than displacing document text or letting the bar disappear.
      if (bottom + 8 + toolbarSize.height <= pageSizePx.height) {
        toolbarFrame = { ...editorFrame, height: bottom - editorFrame.top };
        placedToolbar = toolbarOffsetInFrame(toolbarFrame, toolbarSize, pageSizePx, 8);
      }
    }
  }
  const toolbarOffset = {
    left: toolbarFrame.left + placedToolbar.left - layoutFrame.left,
    top: toolbarFrame.top + placedToolbar.top - layoutFrame.top,
  };
  const placedError = toolbarOffsetInFrame(toolbarFrame, errorSize, pageSizePx, toolbarSize.height + 16);
  const errorOffset = {
    left: visualFrame.left + placedError.left,
    top: visualFrame.top + placedError.top,
  };
  // A right or centre box now starts where its neighbour ends, so a handle hanging
  // outside that corner would sit back on the neighbour's words. Keep it inside, where
  // such a box always has empty room before its own text.
  const moveHandleOffset = usesAlignmentColumn ? { left: 0, top: 0 } : { left: -8, top: -8 };
  const lineHeight = textBlockLineHeight(block, style, paragraphMode);
  const previewScaleX = compositionPreviewActive && sourceCompositionsRef.current.length === 1 && compositionRef.current?.pieces.length === 1 ? initialScaleX : 1;
  const initialMeasuredWidth = compositionRef.current ? compositionWidth(compositionRef.current) : 0;
  const sourceXCorrectionPt = compositionPreviewActive && compositionRef.current
    ? compositionRef.current.pieces[0]!.x - boxLeftPt - (initialAlign === 'center' ? (width - initialMeasuredWidth) / 2 : initialAlign === 'right' ? width - initialMeasuredWidth : 0)
    : 0;
  const firstLineOffsetPx = editorFirstLineOffsetPx(lineHeight, style.fontSizePt, zoom) - topCorrectionPx;
  const baselineCorrection = baselineCorrectionPx(
    expectedBaselinePx === undefined ? undefined
      : expectedBaselinePx + (style.fontSizePt - initialStyle.fontSizePt) * baselineFontSizeSlopePx,
    screenRect.top + firstLineOffsetPx,
    measuredBaselineOffset,
    style.fontSizePt * zoom,
  );
  const measureBaseline = useCallback(() => {
    const probe = baselineProbeRef.current;
    const marker = baselineMarkerRef.current;
    const sample = baselineSampleRef.current;
    const editable = editableRef.current;
    // The root's font alone is not enough when the first line contains an inline
    // size/family override. Mirror it only in the hidden probe, never the editor.
    // This runs on font/layout changes, not on input or composition events.
    if (sample && editable) {
      sample.replaceChildren(...Array.from(editable.childNodes, (node) => node.cloneNode(true)));
      if (!sample.hasChildNodes()) sample.textContent = 'M';
      if ((paragraphMode || compositionRef.current) && marker) {
        const first = sample.querySelector<HTMLElement>('[data-pdf-paragraph], [data-pdf-composition-line]');
        if (first && !hasRootParagraphText(editable)) first.prepend(marker);
        else probe?.insertBefore(marker, sample);
      }
    }
    const probeRect = probe?.getBoundingClientRect();
    const markerRect = marker?.getBoundingClientRect();
    // A real zero-size marker has a meaningful top; jsdom's entire probe has no layout.
    const offset = probeRect && markerRect && probeRect.height > 0
      ? markerRect.top - probeRect.top : undefined;
    setMeasuredBaselineOffset((current) => current === offset ? current : offset);
  }, [paragraphMode]);
  const visibleError = externalError
    ?? scriptError
    ?? appearanceError
    ?? (bulletOverflow ? BULLET_NO_ROOM_MESSAGE : undefined);
  const measureFrame = useCallback(() => {
    const editable = editableRef.current;
    const layout = layoutRef.current;
    if (!editable || !layout) return;
    const next = liveTextFrame(editable, layout.getBoundingClientRect(), zoom, lineHeight * zoom);
    if (!next) return;
    setInkFrame((current) => current && (
      Math.abs(current.left - next.left) < 0.01 && Math.abs(current.top - next.top) < 0.01 &&
      Math.abs(current.width - next.width) < 0.01 && Math.abs(current.height - next.height) < 0.01
    ) ? current : next);
  }, [lineHeight, zoom]);
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
    measureFrame();
  }, [lineHeight, measureFrame, zoom]);

  const normalizeParagraphs = useCallback(() => {
    const editable = editableRef.current;
    if (editable && paragraphMode && !composingRef.current) {
      normalizeParagraphDom(editable, paragraphCacheRef.current, paragraphGap, zoom);
    }
  }, [paragraphMode, paragraphGap, zoom]);
  const updatePiecePresentation = useCallback(() => {
    const editable = editableRef.current, source = compositionRef.current;
    if (!editable || !source || composingRef.current) return;
    const value = serializeRichText(editable, style, zoom);
    const parts = value.text.split('\n'), spans = value.spans ? splitParagraphSpans(value.spans) : undefined;
    const active = parts.length === sourceCompositionsRef.current.length && sourceCompositionsRef.current.every((composition, index) => composition
      && 'composition' in composeTextLine({ ...composition, style: initialStyle }, parts[index]!, value.style, measureTextWidth ?? measurePieceWithCanvas, { spans: spans?.[index] }));
    setCompositionPreviewActive(active);
    editable.querySelectorAll<HTMLElement>('[data-pdf-composition-line]').forEach(wrapper => {
      const line = sourceCompositionsRef.current[Number(wrapper.dataset.pdfCompositionLine)];
      if (!line) return;
      wrapper.style.position = 'relative';
      const offset = line.pieces[0]!.x - boxLeftPt - (initialAlign === 'center' ? (width - compositionWidth(line)) / 2 : initialAlign === 'right' ? width - compositionWidth(line) : 0) - sourceXCorrectionPt - (initialParagraphs?.[Number(wrapper.dataset.pdfCompositionLine)]?.firstIndentPt ?? 0);
      wrapper.style.left = `${active ? offset * zoom : 0}px`;
    });
    editable.querySelectorAll<HTMLElement>('[data-pdf-source-piece]').forEach(wrapper => {
      const index = Number(wrapper.dataset.pdfSourcePiece), line = sourceCompositionsRef.current[Number(wrapper.dataset.pdfSourceLine ?? 0)], piece = line?.pieces[index], content = wrapper.querySelector<HTMLElement>('[data-pdf-piece-content]');
      if (!piece || !content) return;
      if (!active) { wrapper.style.marginLeft = '0px'; content.style.setProperty('--pdf-piece-tracking','0px'); content.style.letterSpacing = ''; return; }
      const previous = line?.pieces[index - 1];
      if (previous && line) {
        let cursor = 0, separator = '';
        for (const member of line.pieces.slice(0, index + 1)) {
          const start = line.text.indexOf(member.text, cursor);
          separator = line.text.slice(cursor, start); cursor = start + member.text.length;
        }
        wrapper.style.marginLeft = `${(piece.x - previous.x - previous.widthPt - canvasWidth(separator, initialStyle)) * zoom}px`;
      } else wrapper.style.marginLeft = '0px';
      content.style.setProperty('--pdf-piece-tracking',`${(piece.advanceTrackingPt ?? 0) * zoom}px`);
      content.style.letterSpacing = `calc(var(--pdf-piece-tracking,0px) + ${(piece.style.fontTrackingEm ?? 0) * piece.style.fontSizePt * zoom}px)`;
    });
  }, [boxLeftPt, initialAlign, initialParagraphs, initialStyle, measureTextWidth, sourceXCorrectionPt, style, width, zoom]);
  const updateParagraphPresentation = useCallback(() => {
    const editable = editableRef.current;
    if (editable && !composingRef.current) refreshParagraphPresentation(editable, paragraphSnapshotsRef.current, style, zoom);
    if (!editable || initialAlign !== 'justify' || composingRef.current) return;
    const measure = (text: string, span: import('@/lib/export/types').TextSpan) => (measureTextWidth ?? measurePieceWithCanvas)(text, effectiveTextSpanStyle(style, span));
    editable.querySelectorAll<HTMLElement>('[data-pdf-paragraph]').forEach(paragraph => {
      paragraph.style.textAlign = 'justify'; paragraph.style.textAlignLast = 'left';
      delete paragraph.dataset.pdfJustifyTail;
      paragraph.style.wordSpacing = 'normal';
      if (paragraph.dataset.pdfFlowing !== 'true') return;
      const value = serializeRichText(paragraph, style, zoom), layout = readParagraphLayout(paragraph);
      const spans = effectiveTextSpans(value.text, value.style, value.spans);
      const spacing = minimumWordSpacing(spans, value.style, measure, layout.minimumWordGapEm);
      paragraph.style.wordSpacing = `${spacing * zoom}px`;
      paragraph.style.setProperty('--pdf-word-space', `${spacing * zoom}px`);
      const lines = wrapTextParagraphs({ text: value.text, style: value.style, spans: value.spans, paragraphs: [layout],
        width, height: 0, dx: 0, dy: 0, align: 'justify' }, measure);
      const last = lines.at(-1), natural = last ? effectiveTextSpans(last.text, value.style, last.spans).reduce((sum, span) => sum + measure(span.text, span), 0) : 0;
      const tail = Math.max(0, width - (lines.length === 1 ? layout.firstIndentPt : layout.restIndentPt) - natural);
      // A generated WORD JOINER keeps the invisible tail with the last word.
      // Last-line justification then restores NORMAL visible gaps, not a full
      // stretched last line. Nothing is added to the editable/serialized text.
      paragraph.dataset.pdfJustifyTail = spacing < 0 ? 'true' : 'false';
      paragraph.style.setProperty('--pdf-justify-tail-width', `${tail * zoom}px`);
      if (spacing < 0) paragraph.style.textAlignLast = 'justify';
    });
  }, [initialAlign, measureTextWidth, style, width, zoom]);
  const refreshWordFonts = useCallback(() => {
    const editable = editableRef.current; if (!editable) return;
    // Presentation attributes only: never replace a text node while typing.
    const words = [...editable.querySelectorAll<HTMLElement>('[data-pdf-font-word]')];
    let text = '';
    const fragments = words.map(word => {
      const ancestors: HTMLElement[] = []; let node: HTMLElement | null = word;
      while (node && node !== editable) { ancestors.unshift(node); node = node.parentElement; }
      const wordStyle = ancestors.reduce((inherited, element) => elementTextStyle(element, inherited, zoom), style);
      const start = text.length, content = word.textContent ?? ''; text += content;
      return { word, start, text: content, style: wordStyle };
    });
    const fallback = fallbackWordRanges(text, fragments, canUseSourceWord);
    for (const part of fragments) {
      const { word, style: wordStyle } = part;
      const forceFallback = overlapsFallback(part.start, part.text.length, fallback);
      const paint = (element: HTMLElement, resolved: TextStyle) => {
        const family = textFontFamily(forceFallback ? { ...resolved, fontRef: undefined } : resolved, part.text);
        if (element.style.fontFamily.replaceAll('"', '') !== family.replaceAll('"', '')) element.style.fontFamily = family;
        // Native B/I creates formatting descendants inside a word wrapper.
        // Give each formatting run its actual matched variant, not browser
        // synthesis of the regular wrapper's uniquely-named font family.
        element.dataset.fontName = resolved.fontName;
        if (resolved.fontIdentity) element.dataset.fontIdentity = resolved.fontIdentity;
        else delete element.dataset.fontIdentity;
        if (resolved.fontWidthScale !== undefined) element.dataset.fontWidthScale = String(resolved.fontWidthScale);
        else delete element.dataset.fontWidthScale;
        if (resolved.fontTrackingEm !== undefined) element.dataset.fontTrackingEm = String(resolved.fontTrackingEm);
        else delete element.dataset.fontTrackingEm;
        element.style.letterSpacing = `calc(var(--pdf-piece-tracking,0px) + ${(resolved.fontTrackingEm ?? 0) * resolved.fontSizePt * zoom}px)`;
        void ensureMatchedFont(resolved).catch(() => undefined);
        for (const child of element.children) {
          if (child instanceof HTMLElement) paint(child, elementTextStyle(child, resolved, zoom));
        }
      };
      paint(word, wordStyle);
    }
  }, [style, zoom]);
  const handleInput = useCallback(() => {
    setScriptError(indicEditMessage(editableRef.current?.textContent ?? ''));
    refreshWordFonts(); normalizeParagraphs(); updateParagraphPresentation(); updatePiecePresentation(); resizeToContent();
  }, [refreshWordFonts, normalizeParagraphs, updateParagraphPresentation, updatePiecePresentation, resizeToContent]);

  const updateBulletPresentation = useCallback(() => {
    if (editableRef.current && bulletMode?.indentPt !== undefined) refreshBulletEditorLayout(editableRef.current,bulletMode.indentPt,
      (bulletMode.itemSpacingPt ?? 0) * style.fontSizePt / Math.max(1,block.style.fontSizePt),zoom);
  }, [bulletMode?.indentPt,bulletMode?.itemSpacingPt,style.fontSizePt,block.style.fontSizePt,zoom]);
  useLayoutEffect(() => { if (initializedRef.current) { updateBulletPresentation(); resizeToContent(); } }, [updateBulletPresentation,resizeToContent]);

  const fontSeedRef = useRef([initialStyle, ...effectiveTextSpans(initialText, initialStyle, initialSpans).map(span => effectiveTextSpanStyle(initialStyle, span))]);
  useEffect(() => {
    let disposed = false;
    void Promise.all([style, ...fontSeedRef.current].map(ensureMatchedFont))
      .then(() => { if (!disposed) { refreshWordFonts(); updateParagraphPresentation(); resizeToContent(); } })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [style, refreshWordFonts, updateParagraphPresentation, resizeToContent]);

  useLayoutEffect(() => {
    const editable = editableRef.current;
    if (!editable) return;
    if (!initializedRef.current) {
      editable.innerHTML = initialHtmlRef.current;
      if (paragraphPresentationRef.current || (compositionRef.current && sourceCompositionsRef.current.length > 1)) initialPresentedValueRef.current = serializeRichText(editable, initialStyle, zoom);
      paragraphSnapshotsRef.current = snapshotParagraphs(editable, initialStyle, zoom);
      initializedRef.current = true;
      editable.focus({ preventScroll: true });
      placeCaretAtEnd(editable);
    }
    updateBulletPresentation();
    resizeToContent();
  }, [resizeToContent, updateBulletPresentation, width, style, previewMode, baselineCorrection, initialStyle, zoom]);

  useLayoutEffect(() => {
    measureBaseline();
  }, [measureBaseline, style, lineHeight, firstLineOffsetPx, zoom]);

  useLayoutEffect(() => { updatePiecePresentation(); }, [updatePiecePresentation]);
  useLayoutEffect(() => { updateParagraphPresentation(); }, [updateParagraphPresentation]);

  useEffect(() => {
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      if (editableRef.current && !composingRef.current) recalibrateParagraphRows(editableRef.current, style, zoom, measureTextWidth ?? measurePieceWithCanvas);
      measureBaseline();
    };
    const fonts = document.fonts;
    void fonts?.ready.then(measure);
    fonts?.addEventListener('loadingdone', measure);
    window.addEventListener('resize', measure);
    const probe = baselineProbeRef.current;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (probe) observer?.observe(probe);
    return () => {
      disposed = true;
      fonts?.removeEventListener('loadingdone', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [measureBaseline, measureTextWidth, style, zoom]);

  useEffect(() => {
    const editable = editableRef.current;
    if (!editable) return;
    let animation: number | undefined;
    let disposed = false;
    const schedule = () => {
      if (disposed || animation !== undefined) return;
      if (typeof window.requestAnimationFrame !== 'function') return;
      animation = window.requestAnimationFrame(() => {
        animation = undefined;
        resizeToContent();
      });
    };
    const mutations = new MutationObserver((records) => {
      // resizeToContent writes the root's height; observing our own write would
      // schedule a new measurement every animation frame.
      if (records.some((record) => record.type !== 'attributes' || record.target !== editable)) schedule();
    });
    mutations.observe(editable, { childList: true, subtree: true, characterData: true, attributes: true });
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    resize?.observe(editable);
    const fonts = document.fonts;
    void fonts?.ready.then(schedule);
    fonts?.addEventListener('loadingdone', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      disposed = true;
      if (animation !== undefined) window.cancelAnimationFrame(animation);
      mutations.disconnect();
      resize?.disconnect();
      fonts?.removeEventListener('loadingdone', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [resizeToContent]);

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
    refreshWordFonts();
    updateParagraphPresentation();
    measureBaseline();
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
      if (scaleInlineSizes && editable) {
        const start = captureResize();
        if (start) applyCornerScale(start, fontSizePt / start.style.fontSizePt);
        editable.focus({ preventScroll: true });
        return;
      }
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
      editable,
      range,
      { fontSize: `${fontSizePt * zoom}px` },
      { fontSizePt: String(fontSizePt) },
      ['fontSize'],
    );
    selectionRangeRef.current = selected.cloneRange();
    editable.focus({ preventScroll: true });
    refreshSelectionStyle();
    updateParagraphPresentation();
    measureBaseline();
    resizeToContent();
  };

  const captureResize = () => {
    const editable = editableRef.current;
    return editable ? { ...serializeRichText(editable, style, zoom), width, html: editable.innerHTML } : undefined;
  };

  const applyCornerScale = (start: NonNullable<ReturnType<typeof captureResize>>, factor: number) => {
    const editable = editableRef.current;
    if (!editable) return;
    const next = scaleTextBox(start, factor);
    // Only the explicit corner gesture rebuilds the size-scaled runs. Ordinary
    // typing and A+/A− retain their existing paths, and the width never changes.
    editable.innerHTML = next.factor === 1 ? start.html : bulletMode
      ? bulletEditorHtml(next.text, next.style, next.spans, zoom, bulletMode.indentPt ?? 0)
      : richTextToHtml(next.text, next.style, next.spans, zoom, paragraphMode ? next.paragraphs : undefined);
    if (paragraphMode) {
      paragraphCacheRef.current = new Map([...editable.querySelectorAll<HTMLElement>('[data-pdf-paragraph]')]
        .map(paragraph => [paragraph.dataset.paragraphId!, readParagraphLayout(paragraph)]));
    }
    selectionRangeRef.current = null;
    setStyle(next.style);
    setSelectionStyle(value => ({ ...value, fontSizePt: next.style.fontSizePt }));
  };

  const beginCornerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (committing || composingRef.current || event.button !== 0) return;
    event.preventDefault();
    const start = captureResize();
    if (!start) return;
    stopCornerDragRef.current?.();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const x = event.clientX, y = event.clientY;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      applyCornerScale(start, cornerDragFactor(moveEvent.clientX - x, moveEvent.clientY - y, start.style.fontSizePt, zoom));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      stopCornerDragRef.current = undefined;
    };
    stopCornerDragRef.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
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
        fontIdentity: undefined,
        fontWidthScale: undefined,
        fontTrackingEm: undefined,
        sourceBold: undefined,
        sourceStrokeBold: undefined,
      }));
      setSelectionStyle((value) => ({ ...value, family }));
      return;
    }
    const selected = wrapSelectionWithStyle(
      editable,
      range,
      { fontFamily: fontName },
      { fontName },
      ['fontFamily'],
    );
    selectionRangeRef.current = selected.cloneRange();
    refreshSelectionStyle();
    updateParagraphPresentation();
    measureBaseline();
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
      editable,
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
    updateParagraphPresentation();
    resizeToContent();
  };

  const pastePlainText = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const editable = editableRef.current;
    if (!editable) return;
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (bulletMode?.indentPt !== undefined && /[\r\n]/u.test(text)) {
      const prefix = markerPrefixAtLineEnd(editable,style,zoom,false) ?? '• ';
      if (insertBulletItems(editable,text,style,zoom,bulletMode.indentPt,bulletMode.itemSpacingPt ?? 0,prefix)) { updateBulletPresentation(); handleInput(); return; }
    }
    flowSelectedParagraphs(editable);
    if (paragraphMode) insertParagraphText(editable, text);
    else insertPlainText(editable, text);
    handleInput();
  };

  return (
    <div
      ref={layoutRef}
      data-testid="text-editor-layout"
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
      <style>{'[data-pdf-justify-tail="true"]::after{content:"\\2060";font-size:0;letter-spacing:0;word-spacing:0;padding-right:var(--pdf-justify-tail-width,0px)}'}</style>
      <div
        ref={toolbarRef}
        className="absolute z-20 flex flex-wrap items-center gap-1 rounded-lg border border-neutral-300 bg-white p-1 shadow-xl"
        style={{ ...toolbarOffset, width: 'max-content', maxWidth: pageSizePx.width }}
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
          disabled={bulletOverflow || committing || Boolean(scriptError)}
          className="rounded bg-neutral-900 px-2 py-1 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-400"
        >
          Done
        </button>
      </div>

      {visibleError && (
        <div
          ref={errorRef}
          role="alert"
          className="absolute z-30 max-w-sm rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 shadow"
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
        data-pdf-paragraph-editor={paragraphMode ? 'true' : undefined}
        onBeforeInput={(event) => {
          if (!(event.nativeEvent as InputEvent).inputType?.startsWith('history') && editableRef.current) flowSelectedParagraphs(editableRef.current);
        }}
        onInput={() => { updateBulletPresentation(); handleInput(); }}
        onCompositionStart={()=>{if (editableRef.current) flowSelectedParagraphs(editableRef.current);composingRef.current=true;}}
        onCompositionUpdate={resizeToContent}
        onCompositionEnd={()=>{composingRef.current=false;handleInput();}}
        onPaste={pastePlainText}
        onKeyDown={(event) => {
          if (committing || composingRef.current || event.nativeEvent.isComposing) return;
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const editable = editableRef.current;
            if (editable && bulletMode?.indentPt !== undefined) {
              const prefix = markerPrefixAtLineEnd(editable,style,zoom,false) ?? '• ';
              if (insertBulletItems(editable,'\n',style,zoom,bulletMode.indentPt,bulletMode.itemSpacingPt ?? 0,prefix)) { updateBulletPresentation(); handleInput(); return; }
            }
            if (editable && paragraphMode) {
              flowSelectedParagraphs(editable);
              insertParagraphBreak(editable); handleInput(); return;
            }
            if (editable) {
              const markerPrefix = markerList || bulletMode
                ? markerPrefixAtLineEnd(editable, style, zoom, !bulletMode)
                : undefined;
              insertPlainText(editable, `\n${markerPrefix ?? (bulletMode ? '• ' : '')}`);
            }
            resizeToContent();
          } else if (event.key === 'Backspace' && paragraphMode && typeof document.execCommand !== 'function') {
            const editable = editableRef.current;
            if (editable && mergeParagraphBackward(editable)) { event.preventDefault(); handleInput(); }
          }
        }}
        className="relative z-0 block w-full overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 outline-none"
        style={{
          ...textStyleToCss(style, zoom),
          // New unwrapped text nodes also use a complete fallback face. Source
          // word spans explicitly opt back into the PDF face when safe.
          ...(style.fontIdentity ? { fontFamily: textFontFamily({ ...style, fontRef: undefined }) } : {}),
          ...(previewMode === 'preparing' ? {WebkitTextFillColor:'transparent',caretColor:colorCss(style.color)} : {}),
          lineHeight: lineHeight / style.fontSizePt,
          top: firstLineOffsetPx + baselineCorrection,
          textAlign: initialAlign,
          ...(compositionPreviewActive ? { width: `${width * zoom / previewScaleX}px`, left: sourceXCorrectionPt * zoom,
            transform: `scaleX(${previewScaleX})`, transformOrigin: 'left top' } : {}),
        }}
      />
      <div
        ref={baselineProbeRef}
        data-testid="text-baseline-probe"
        aria-hidden="true"
        className="pointer-events-none invisible absolute w-full whitespace-pre-wrap break-words border-0 p-0"
        style={{ ...textStyleToCss(style, zoom), lineHeight: lineHeight / style.fontSizePt, top: firstLineOffsetPx }}
      >
        <span ref={baselineMarkerRef} data-testid="text-baseline-marker"
          style={{ display: 'inline-block', width: 0, height: 0, padding: 0, border: 0, verticalAlign: 'baseline' }} /><span
          ref={baselineSampleRef} style={{ display: 'contents' }} />
      </div>
      <div
        data-testid="text-editor-frame"
        aria-hidden="true"
        className="pointer-events-none absolute z-10 rounded-sm outline outline-1 outline-blue-500"
        style={visualFrame}
      />
      <button
        type="button"
        aria-label="Drag to change text width"
        onPointerDown={beginWidthDrag}
        style={{ left: visualFrame.left + visualFrame.width - 5, top: visualFrame.top + visualFrame.height / 2 - 5 }}
        className="absolute z-10 h-2.5 w-2.5 cursor-ew-resize rounded-sm border border-white bg-blue-500 hover:bg-blue-600"
      />
      <button
        type="button"
        aria-label="Drag to resize text"
        title="Drag to resize text; arrow keys resize, Shift for bigger steps"
        disabled={committing}
        onPointerDown={beginCornerDrag}
        onKeyDown={(event) => {
          const direction = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
          if (!direction || composingRef.current) return;
          event.preventDefault();
          const start = captureResize();
          if (start) applyCornerScale(start, (start.style.fontSizePt + direction * (event.shiftKey ? 10 : 1)) / start.style.fontSizePt);
        }}
        style={{ left: visualFrame.left + visualFrame.width - 5, top: visualFrame.top + visualFrame.height - 5 }}
        className="absolute z-20 h-2.5 w-2.5 touch-none cursor-nwse-resize rounded-sm border border-white bg-blue-500 hover:bg-blue-600"
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
        style={{ left: visualFrame.left + moveHandleOffset.left, top: visualFrame.top + moveHandleOffset.top }}
        className="absolute z-20 h-4 w-4 cursor-move rounded-full border border-white bg-blue-600 text-[10px] font-bold leading-none text-white shadow hover:bg-blue-700"
      >
        ✥
      </button>
    </div>
  );
}
