import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { TextEdit, TextStyle } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { ScreenRect } from '@/lib/export/coordinates';
import { textBlockLineHeight } from '@/lib/edit/buildTextEdits';
import type { NextTextEdit } from '@/lib/edit/buildTextEdits';
import {
  calculateBulletRoomPt,
  calculateInitialEditorWidth,
  finishTextEdit,
} from '@/lib/edit/textEditSession';
import { textStyleToCanvasFont, textStyleToCss } from '@/lib/edit/textStyleCss';
import { editorFirstLineOffsetPx } from '@/lib/edit/editorPosition';
import { classifyFontFamily } from '@/lib/pdf/textContent';
import { richTextToHtml, serializeRichText } from '@/lib/edit/richText';
import {
  SNAP_THRESHOLD_PX,
  snapAxis,
} from '@/lib/edit/moveSnap';
import type { MoveGuideState, SnapTarget } from '@/lib/edit/moveSnap';
import { BULLET_NO_ROOM_MESSAGE, formatBulletEditorText } from '@/lib/pdf/bulletList';
import { toolbarOffsetInFrame, useElementSize } from '@/lib/edit/floatingToolbar';
import type { ElementSize } from '@/lib/edit/floatingToolbar';
import { FontSizeCombobox } from './FontSizeCombobox';

const FAMILY_KEYWORD = {
  sans: 'Arial',
  serif: 'Times New Roman',
  mono: 'Courier New',
} as const;
type FamilyKey = keyof typeof FAMILY_KEYWORD;

const MIN_BOX_WIDTH = 12;
const MIN_BOX_HEIGHT = 8;

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
  clearedProperties: readonly ('fontSize' | 'fontFamily')[],
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
    }
  }
  wrapper.append(fragment);
  range.insertNode(wrapper);
  return selectWrappedRange(wrapper);
}

function measureWidestInitialLine(text: string, style: TextStyle): number {
  const canvas = window.document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return 0;
  context.font = textStyleToCanvasFont(style);
  return Math.max(
    0,
    ...text.replace(/\r\n?/g, '\n').split('\n').map((line) => context.measureText(line).width),
  );
}

interface TextEditOverlayProps {
  readonly block: TextBlock;
  readonly existing?: readonly TextEdit[];
  readonly screenRect: ScreenRect;
  /** Box-only source-ink adjustment; content cancels it to retain the PDF baseline. */
  readonly topCorrectionPx?: number;
  readonly zoom: number;
  readonly pageWidthPt: number;
  /** Page box in CSS pixels; floating bars are kept inside it because the page clips overflow. */
  readonly pageSizePx: ElementSize;
  readonly backgroundColor: string;
  readonly verticalTargets: readonly SnapTarget[];
  readonly horizontalTargets: readonly SnapTarget[];
  readonly bulletMode?: {
    readonly items: readonly string[];
    readonly maxHeightPt: number;
  };
  readonly externalError?: string;
  onMoveStateChange(state: MoveGuideState | null): void;
  onDone(next: NextTextEdit): void;
  onCancel(): void;
}

export function TextEditOverlay({
  block,
  existing,
  screenRect,
  topCorrectionPx = 0,
  zoom,
  pageWidthPt,
  pageSizePx,
  backgroundColor,
  verticalTargets,
  horizontalTargets,
  bulletMode,
  externalError,
  onMoveStateChange,
  onDone,
  onCancel,
}: TextEditOverlayProps) {
  const initialText = existing?.[0]?.boxText ??
    (bulletMode ? formatBulletEditorText(bulletMode.items) : undefined) ??
    existing?.map((edit) => edit.text).join('\n') ??
    block.text;
  // Re-opening a bullet list must seed its font from a body line, not the "•" marker
  // (whose style deliberately drops fontRef); recover a lost fontRef from the block so a
  // list damaged by an earlier re-edit heals its embedded font on the next edit.
  const initialStyle = (() => {
    if (!bulletMode) return existing?.[0]?.style ?? block.style;
    const body = existing?.find((edit) => edit.text !== '•')?.style ?? block.style;
    return body.fontRef ? body : { ...body, fontRef: block.style.fontRef };
  })();
  const initialSpans = existing?.[0]?.boxSpans ?? (existing?.length === 1 ? existing[0]?.spans : undefined);
  const initialAlign = bulletMode ? 'left' : (existing?.[0]?.align ?? block.align ?? 'left');
  const initialAlignLeftPt = existing?.[0]?.alignLeftPt ?? block.alignLeftPt ?? block.rect.x;
  const initialAlignWidthPt = existing?.[0]?.alignWidthPt ?? block.alignWidthPt ?? block.rect.w;
  const usesAlignmentColumn = initialAlign !== 'left';
  const initialHtmlRef = useRef(richTextToHtml(initialText, initialStyle, initialSpans, zoom));
  const [style, setStyle] = useState<TextStyle>(initialStyle);
  const [selectionStyle, setSelectionStyle] = useState({
    bold: initialStyle.bold,
    italic: initialStyle.italic,
    fontSizePt: initialStyle.fontSizePt,
    family: classifyFontFamily(initialStyle.fontName) as FamilyKey,
  });
  const naturalWidth = usesAlignmentColumn ? initialAlignWidthPt : block.rect.w;
  const [initialWidth] = useState(() => bulletMode
    ? Math.max(naturalWidth, existing?.[0]?.rect.w ?? 0)
    : usesAlignmentColumn
      ? Math.max(MIN_BOX_WIDTH, initialAlignWidthPt)
      : calculateInitialEditorWidth({
        blockWidthPt: naturalWidth,
        blockXPt: block.rect.x,
        existingWidthPt: existing?.[0]?.rect.w,
        fontSizePt: initialStyle.fontSizePt,
        measuredLineWidthPt: measureWidestInitialLine(initialText, initialStyle),
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
        x: screenRect.left + startOffset.x,
        y: screenRect.top + startOffset.y,
      },
    });

    const move = (moveEvent: PointerEvent) => {
      const rawOffset = {
        x: startOffset.x + moveEvent.clientX - startX,
        y: startOffset.y + moveEvent.clientY - startY,
      };
      const rawLeft = screenRect.left + rawOffset.x;
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
          x: screenRect.left + snappedOffset.x,
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
      ...(usesAlignmentColumn ? {
        align: initialAlign,
        alignLeftPt: initialAlignLeftPt,
        alignWidthPt: width,
      } : {}),
    };
    if (bulletOverflow) return;
    finishTextEdit(
      {
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
          alignWidthPt: initialWidth,
        } : {}),
      },
      next,
      onDone,
      onCancel,
    );
  };
  const editorFrame: ScreenRect = {
    left: screenRect.left + moveOffset.x,
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
  const lineHeight = textBlockLineHeight(block, style);
  const firstLineOffsetPx = editorFirstLineOffsetPx(lineHeight, style.fontSizePt, zoom) - topCorrectionPx;
  const visibleError = externalError ?? (bulletOverflow ? BULLET_NO_ROOM_MESSAGE : undefined);
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
    const computed = window.getComputedStyle(elementAtRangeStart(range, editable));
    const fontSizePt = Number.parseFloat(computed.fontSize) / zoom || style.fontSizePt;
    const family = classifyFontFamily(computed.fontFamily) as FamilyKey;
    setSelectionStyle((current) => (
      current.bold === bold &&
      current.italic === italic &&
      current.fontSizePt === fontSizePt &&
      current.family === family
        ? current
        : { bold, italic, fontSizePt, family }
    ));
  }, [style.fontSizePt, zoom]);

  useEffect(() => {
    window.document.addEventListener('selectionchange', refreshSelectionStyle);
    return () => window.document.removeEventListener('selectionchange', refreshSelectionStyle);
  }, [refreshSelectionStyle]);

  useEffect(() => () => onMoveStateChange(null), [onMoveStateChange]);

  const applyInlineStyle = (command: 'bold' | 'italic') => {
    const editable = editableRef.current;
    if (!editable) return;
    if (!selectionRangeInside(editable)) {
      const savedRange = selectionRangeRef.current;
      if (!savedRange || !editable.contains(savedRange.commonAncestorContainer)) return;
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(savedRange.cloneRange());
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
      setStyle((value) => ({ ...value, fontName, fontRef: undefined }));
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
      style={{
        left: screenRect.left + moveOffset.x,
        top: screenRect.top + moveOffset.y,
        width: width * zoom,
        height: height * zoom,
        backgroundColor,
      }}
    >
      <div
        ref={toolbarRef}
        className="absolute z-20 flex items-center gap-1 rounded-lg border border-neutral-300 bg-white p-1 shadow-xl"
        style={toolbarOffset}
        role="toolbar"
        aria-label="Text formatting"
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
        <span className="mx-1 h-5 w-px bg-neutral-200" />
        <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100">Cancel</button>
        <button
          type="button"
          data-text-edit-done
          onClick={commit}
          disabled={bulletOverflow}
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
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onInput={resizeToContent}
        onPaste={pastePlainText}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const editable = editableRef.current;
            if (editable) insertPlainText(editable, bulletMode ? '\n• ' : '\n');
            resizeToContent();
          }
        }}
        className="relative z-0 block w-full overflow-hidden whitespace-pre-wrap break-words rounded-sm border-0 bg-transparent p-0 outline outline-2 outline-blue-500"
        style={{
          ...textStyleToCss(style, zoom),
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
        className="absolute -left-3 -top-3 z-20 h-6 w-6 cursor-move rounded-full border-2 border-white bg-blue-600 text-xs font-bold leading-none text-white shadow hover:bg-blue-700"
      >
        ✥
      </button>
    </div>
  );
}
