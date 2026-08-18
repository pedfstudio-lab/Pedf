import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import {
  pdfRectToScreenRect,
  pdfToViewport,
  screenRectToPdfRect,
} from '@/lib/export/coordinates';
import type { ScreenRect } from '@/lib/export/coordinates';
import type { CoverEdit, PdfRect, Rgb, TextEdit, TextStyle } from '@/lib/export/types';
import { sampleDominantColor } from '@/lib/export/colorSample';
import {
  buildBulletListEdits,
  buildFreeTextEdits,
  buildTextBlockEdits,
  coverRectForBulletList,
  coverRectForTextBlock,
  coverRectsForTextBlock,
  freeTextLineHeight,
} from '@/lib/edit/buildTextEdits';
import type { BulletListItemLayout, NextTextEdit } from '@/lib/edit/buildTextEdits';
import { wrapTextSpansToLines, wrapTextToLines } from '@/lib/edit/textLayout';
import { textStyleToCanvasFont, textStyleToCss } from '@/lib/edit/textStyleCss';
import {
  bulletReflowKey,
  columnPushRoom,
  contentBelowInColumn,
  initialListHeight,
  planColumnPush,
  pushColumnEdits,
} from '@/lib/edit/columnPush';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import type { TextBlock, TextRun } from '@/lib/pdf/textContent';
import {
  bulletEditorBlock,
  bulletListHeadingBlock,
  detectBulletListFromRegions,
  formatBulletEditorText,
  parseBulletEditorItems,
} from '@/lib/pdf/bulletList';
import type { BulletList } from '@/lib/pdf/bulletList';
import { detectImages } from '@/lib/pdf/images';
import type { ImageRegion } from '@/lib/pdf/images';
import { detectDates } from '@/lib/smart/dateDetect';
import { useDocumentStore } from '@/state/documentStore';
import { useEdits } from '@/state/editsStore';
import { SmartSpanLayer } from './SmartSpanLayer';
import { TapPopover } from './TapPopover';
import { TextEditOverlay } from './TextEditOverlay';
import { ImageOverlay } from './ImageOverlay';

interface OverlayLayerProps {
  readonly page: PDFPageProxy;
  readonly pageIndex: number;
  readonly viewport: PageViewport;
  readonly dpr: number;
  readonly zoom: number;
  readonly editMode: boolean;
  readonly textAddMode: boolean;
  readonly imageMode: boolean;
  readonly peek: boolean;
}

interface ExistingBlock {
  readonly covers: readonly CoverEdit[];
  readonly texts: readonly TextEdit[];
}

interface PopoverTarget {
  readonly block: TextBlock;
  readonly text: string;
  readonly screenRect: ReturnType<typeof pdfRectToScreenRect>;
  readonly bulletList?: BulletList;
}

interface FreeTextSession {
  readonly block: TextBlock;
  readonly existing?: readonly TextEdit[];
  readonly boxId?: string;
}

const WHITE_BACKGROUND: Rgb = { r: 1, g: 1, b: 1 };
const DEFAULT_TEXT_STYLE: TextStyle = {
  fontName: 'Helvetica',
  fontSizePt: 14,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};
const DEFAULT_FREE_TEXT_WIDTH_PT = 180;
const DEFAULT_FREE_TEXT_HEIGHT_PT = 18;
const MIN_FREE_TEXT_DRAW_PX = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  const epsilon = 0.01;
  return (
    Math.abs(left.x - right.x) < epsilon &&
    Math.abs(left.y - right.y) < epsilon &&
    Math.abs(left.w - right.w) < epsilon &&
    Math.abs(left.h - right.h) < epsilon
  );
}

function isBlockAnchor(block: TextBlock, edit: CoverEdit): boolean {
  const firstLine = coverRectsForTextBlock(block)[0];
  return (
    block.pageIndex === edit.pageIndex &&
    ((firstLine && sameRect(firstLine, edit.rect)) ||
      sameRect(coverRectForTextBlock(block), edit.rect) ||
      sameRect(block.rect, edit.rect))
  );
}

function unionRects(rects: readonly PdfRect[]): PdfRect {
  const first = rects[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const bottom = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

function textBoxRect(texts: readonly TextEdit[]): PdfRect {
  const union = unionRects(texts.map((edit) => edit.rect));
  const height = texts[0]?.boxHeight ?? union.h;
  const top = Math.max(...texts.map((edit) => edit.rect.y + edit.rect.h));
  return { x: union.x, y: top - height, w: union.w, h: height };
}

function sourceText(texts: readonly TextEdit[]): string {
  return texts[0]?.boxText ?? texts.map((edit) => edit.text).join('\n');
}

function freeTextBoxRect(texts: readonly TextEdit[]): PdfRect {
  const first = texts[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };
  const height = first.boxHeight ?? freeTextLineHeight(first.style);
  return {
    x: first.rect.x,
    y: first.rect.y - height,
    w: first.rect.w,
    h: height,
  };
}

function freeTextBlock(pageIndex: number, rect: PdfRect, style = DEFAULT_TEXT_STYLE): TextBlock {
  return {
    pageIndex,
    text: '',
    rect,
    topBaselineY: rect.y + rect.h,
    lineHeightPt: freeTextLineHeight(style),
    style,
    lines: [],
  };
}

function freeTextBlockFromEdits(texts: readonly TextEdit[]): TextBlock {
  const first = texts[0];
  if (!first) throw new Error('Cannot reopen an empty free-text group');
  const rect = freeTextBoxRect(texts);
  const second = texts[1];
  return {
    pageIndex: first.pageIndex,
    text: sourceText(texts),
    rect,
    topBaselineY: first.rect.y,
    lineHeightPt: second
      ? Math.abs(first.rect.y - second.rect.y)
      : freeTextLineHeight(first.style),
    style: first.style,
    lines: [],
  };
}

function wrapNextText(next: NextTextEdit) {
  const canvas = window.document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (next.spans) {
    return wrapTextSpansToLines(
      next.spans,
      next.width,
      (text, span) => {
        if (context) {
          context.font = textStyleToCanvasFont({
            ...next.style,
            bold: span.bold,
            italic: span.italic,
          });
        }
        return context?.measureText(text).width ?? text.length * next.style.fontSizePt * 0.55;
      },
    );
  }
  if (context) context.font = textStyleToCanvasFont(next.style);
  return wrapTextToLines(
    next.text,
    next.width,
    (text) => context?.measureText(text).width ?? text.length * next.style.fontSizePt * 0.55,
  );
}

function wrapBulletItems(list: BulletList, next: NextTextEdit): BulletListItemLayout[] {
  const canvas = window.document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context) context.font = textStyleToCanvasFont(next.style);
  const textWidth = Math.max(1, next.width - Math.max(1, list.textX - list.bulletX));
  return parseBulletEditorItems(next.text).map((text) => ({
    text,
    lines: wrapTextToLines(
      text,
      textWidth,
      (value) => context?.measureText(value).width ?? value.length * next.style.fontSizePt * 0.55,
    ),
  }));
}

function colorCss(color: Rgb): string {
  return `rgb(${Math.round(color.r * 255)} ${Math.round(color.g * 255)} ${Math.round(color.b * 255)})`;
}

export function OverlayLayer({
  page,
  pageIndex,
  viewport,
  dpr,
  zoom,
  editMode,
  textAddMode,
  imageMode,
  peek,
}: OverlayLayerProps) {
  const [runs, setRuns] = useState<TextRun[]>([]);
  const [blocks, setBlocks] = useState<TextBlock[]>([]);
  const [imageRegions, setImageRegions] = useState<ImageRegion[]>([]);
  const [activeBlock, setActiveBlock] = useState<TextBlock | null>(null);
  const [activeBulletList, setActiveBulletList] = useState<BulletList | null>(null);
  const [bulletCommitError, setBulletCommitError] = useState<string>();
  const [popoverTarget, setPopoverTarget] = useState<PopoverTarget | null>(null);
  const [freeTextSession, setFreeTextSession] = useState<FreeTextSession | null>(null);
  const [freeDrawRect, setFreeDrawRect] = useState<ScreenRect>();
  const { edits, addEdits, replaceEdits } = useEdits();
  const { getPageCanvas } = useDocumentStore();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      extractTextRuns(page, pageIndex),
      detectImages(page, pageIndex),
    ]).then(([nextRuns, nextImageRegions]) => {
      if (!cancelled) {
        setRuns(nextRuns);
        setBlocks(groupRunsIntoBlocks(nextRuns));
        setImageRegions(nextImageRegions);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [page, pageIndex]);

  useEffect(() => {
    if (!textAddMode) setFreeDrawRect(undefined);
    if (!textAddMode && !editMode) setFreeTextSession(null);
  }, [editMode, textAddMode]);

  const detectedDates = useMemo(() => detectDates(runs), [runs]);
  const bulletLists = useMemo(
    () => blocks
      .map((block) => detectBulletListFromRegions(block, imageRegions))
      .filter((list): list is BulletList => list !== null),
    [blocks, imageRegions],
  );

  const pageTextEdits = useMemo(
    () => edits
      .filter((edit): edit is TextEdit => edit.kind === 'text' && edit.pageIndex === pageIndex)
      .sort((left, right) => left.z - right.z),
    [edits, pageIndex],
  );
  const pageCoverEdits = useMemo(
    () => edits.filter(
      (edit): edit is CoverEdit => edit.kind === 'cover' && edit.pageIndex === pageIndex,
    ),
    [edits, pageIndex],
  );
  const freeTextGroups = useMemo(() => {
    const grouped = new Map<string, TextEdit[]>();
    for (const edit of pageTextEdits) {
      if (edit.origin !== 'free') continue;
      const key = edit.boxId ?? edit.id;
      const group = grouped.get(key) ?? [];
      group.push(edit);
      grouped.set(key, group);
    }
    return [...grouped.entries()].map(([boxId, texts]) => ({
      boxId,
      texts: texts.sort((left, right) => left.z - right.z),
    }));
  }, [pageTextEdits]);

  const sampleBackground = useCallback((rect: PdfRect): Rgb => {
    const registration = getPageCanvas(pageIndex);
    if (!registration) return WHITE_BACKGROUND;
    const { canvas, viewport: canvasViewport } = registration;
    const first = pdfToViewport(canvasViewport, { x: rect.x, y: rect.y });
    const second = pdfToViewport(canvasViewport, { x: rect.x + rect.w, y: rect.y + rect.h });
    const left = Math.max(0, Math.floor(Math.min(first.x, second.x)));
    const top = Math.max(0, Math.floor(Math.min(first.y, second.y)));
    const right = Math.min(canvas.width, Math.ceil(Math.max(first.x, second.x)));
    const bottom = Math.min(canvas.height, Math.ceil(Math.max(first.y, second.y)));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return WHITE_BACKGROUND;
    try {
      return sampleDominantColor(
        context.getImageData(left, top, Math.max(1, right - left), Math.max(1, bottom - top)).data,
      );
    } catch {
      return WHITE_BACKGROUND;
    }
  }, [getPageCanvas, pageIndex]);

  const findExisting = (block: TextBlock): ExistingBlock | undefined => {
    const anchor = pageCoverEdits.find((edit) => isBlockAnchor(block, edit));
    if (!anchor) return undefined;
    const expectedCovers = coverRectsForTextBlock(block);
    const legacyCover = sameRect(anchor.rect, coverRectForTextBlock(block)) ||
      sameRect(anchor.rect, block.rect);
    const coverCount = legacyCover && !sameRect(anchor.rect, expectedCovers[0] ?? anchor.rect)
      ? 1
      : expectedCovers.length;
    const coversByZ = new Map(pageCoverEdits.map((edit) => [edit.z, edit]));
    const covers = Array.from({ length: coverCount }, (_, index) => coversByZ.get(anchor.z + index))
      .filter((edit): edit is CoverEdit => edit !== undefined);
    const byZ = new Map(
      pageTextEdits
        .filter((edit) => edit.origin !== 'free')
        .map((edit) => [edit.z, edit]),
    );
    const texts: TextEdit[] = [];
    for (let z = anchor.z + coverCount; byZ.has(z); z += 1) {
      const text = byZ.get(z);
      if (text) texts.push(text);
    }
    return { covers: covers.length > 0 ? covers : [anchor], texts };
  };

  const findExistingBulletList = (list: BulletList): ExistingBlock | undefined => {
    const expectedCover = coverRectForBulletList(list);
    const anchor = pageCoverEdits.find((edit) => (
      edit.pageIndex === list.block.pageIndex && sameRect(edit.rect, expectedCover)
    ));
    if (!anchor) return undefined;
    const byZ = new Map(
      pageTextEdits
        .filter((edit) => edit.origin !== 'free')
        .map((edit) => [edit.z, edit]),
    );
    const texts: TextEdit[] = [];
    for (let z = anchor.z + 1; byZ.has(z); z += 1) {
      const text = byZ.get(z);
      if (text) texts.push(text);
    }
    return { covers: [anchor], texts };
  };

  const beginFreeTextPlacement = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || freeTextSession) return;
    event.preventDefault();
    const surface = event.currentTarget;
    const bounds = surface.getBoundingClientRect();
    const start = {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height),
    };
    let latest: ScreenRect = { left: start.x, top: start.y, width: 0, height: 0 };
    setFreeDrawRect(latest);
    surface.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      const x = clamp(moveEvent.clientX - bounds.left, 0, bounds.width);
      const y = clamp(moveEvent.clientY - bounds.top, 0, bounds.height);
      latest = {
        left: Math.min(start.x, x),
        top: Math.min(start.y, y),
        width: Math.abs(x - start.x),
        height: Math.abs(y - start.y),
      };
      setFreeDrawRect(latest);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      setFreeDrawRect(undefined);
    };
    const finish = () => {
      cleanup();
      let placed = latest;
      if (placed.width < MIN_FREE_TEXT_DRAW_PX || placed.height < MIN_FREE_TEXT_DRAW_PX) {
        const width = Math.min(DEFAULT_FREE_TEXT_WIDTH_PT * zoom, bounds.width);
        const height = Math.min(DEFAULT_FREE_TEXT_HEIGHT_PT * zoom, bounds.height);
        placed = {
          left: clamp(start.x, 0, Math.max(0, bounds.width - width)),
          top: clamp(start.y, 0, Math.max(0, bounds.height - height)),
          width,
          height,
        };
      }
      const rect = screenRectToPdfRect(placed, viewport, dpr);
      setActiveBlock(null);
      setPopoverTarget(null);
      setFreeTextSession({ block: freeTextBlock(pageIndex, rect) });
    };
    const cancel = () => cleanup();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  };

  if (peek) return null;

  return (
    <div className="absolute inset-0" aria-label={`Text overlays for page ${pageIndex + 1}`}>
      {pageCoverEdits.map((edit) => {
        const rect = pdfRectToScreenRect(edit.rect, viewport, dpr);
        const background = edit.color ?? sampleBackground(edit.rect);
        return (
          <div
            key={edit.id}
            aria-hidden="true"
            className="pointer-events-none absolute z-[5]"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              backgroundColor: colorCss(background),
            }}
          />
        );
      })}

      {pageTextEdits.map((edit) => {
        const rect = pdfRectToScreenRect(edit.rect, viewport, dpr);
        return (
          <div
            key={edit.id}
            className="pointer-events-none absolute z-10 overflow-visible whitespace-pre bg-transparent"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: Math.max(rect.height, edit.style.fontSizePt * zoom),
              ...textStyleToCss(edit.style, zoom),
            }}
          >
            {edit.spans
              ? edit.spans.map((span, index) => (
                  <span
                    key={`${index}:${span.text}`}
                    style={{
                      fontWeight: span.bold ? 700 : 400,
                      fontStyle: span.italic ? 'italic' : 'normal',
                    }}
                  >
                    {span.text}
                  </span>
                ))
              : edit.text}
          </div>
        );
      })}

      <ImageOverlay
        page={page}
        pageIndex={pageIndex}
        viewport={viewport}
        dpr={dpr}
        imageMode={imageMode}
      />

      <SmartSpanLayer dates={detectedDates} viewport={viewport} dpr={dpr} />

      {textAddMode && !freeTextSession && (
        <div
          className="absolute inset-0 z-40 cursor-crosshair bg-violet-300/5"
          onPointerDown={beginFreeTextPlacement}
          aria-label={`Draw text box on page ${pageIndex + 1}`}
        />
      )}

      {freeDrawRect && (
        <div
          className="pointer-events-none absolute z-[45] border-2 border-dashed border-violet-600 bg-violet-300/15"
          style={freeDrawRect}
        />
      )}

      {textAddMode && !freeTextSession && (
        <div className="pointer-events-none absolute left-3 top-3 z-[45] rounded-md bg-neutral-900/90 px-3 py-2 text-xs font-medium text-white shadow">
          Drag to set a text box, or click for a default width.
        </div>
      )}

      {editMode && blocks.map((block, index) => {
        const list = bulletLists.find((entry) => entry.sourceBlock === block);
        const target = list ? bulletListHeadingBlock(list) : block;
        if (!target) return null;
        const rect = pdfRectToScreenRect(target.rect, viewport, dpr);
        const labelText = target.text.replace(/\s+/g, ' ').trim();
        const existing = findExisting(target);
        const actionText = existing && existing.texts.length > 0
          ? sourceText(existing.texts)
          : target.text;
        return (
          <button
            key={`${block.pageIndex}-${index}-${block.rect.x}-${block.rect.y}`}
            type="button"
            aria-label={`Text actions: ${labelText}`}
            title={labelText}
            onClick={() => {
              setActiveBlock(null);
              setActiveBulletList(null);
              setPopoverTarget({ block: target, text: actionText, screenRect: rect });
            }}
            className="absolute z-20 cursor-text rounded-sm border border-transparent bg-transparent hover:border-blue-400 hover:bg-blue-300/20 focus:border-blue-500 focus:bg-blue-300/20 focus:outline-none"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: Math.max(8, rect.height) }}
          />
        );
      })}

      {editMode && bulletLists.map((list, index) => {
        const existing = findExistingBulletList(list);
        const actionText = existing
          ? sourceText(existing.texts)
          : formatBulletEditorText(list.items.map((item) => item.text));
        const rect = pdfRectToScreenRect(
          existing && existing.texts.length > 0 ? textBoxRect(existing.texts) : list.coverRect,
          viewport,
          dpr,
        );
        const label = actionText.replace(/\s+/g, ' ').trim() || 'empty bullet list';
        return (
          <button
            key={`bullet-list-${list.block.pageIndex}-${index}-${list.coverRect.y}`}
            type="button"
            aria-label={`Bullet list actions: ${label}`}
            title={label}
            onClick={() => {
              setActiveBlock(null);
              setActiveBulletList(null);
              setPopoverTarget({
                block: list.block,
                bulletList: list,
                text: actionText,
                screenRect: rect,
              });
            }}
            className="absolute z-[26] cursor-text rounded-sm border border-transparent bg-transparent hover:border-amber-500 hover:bg-amber-300/15 focus:border-amber-600 focus:outline-none"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: Math.max(8, rect.height) }}
          />
        );
      })}

      {editMode && freeTextGroups.map(({ boxId, texts }) => {
        const rect = pdfRectToScreenRect(freeTextBoxRect(texts), viewport, dpr);
        const label = sourceText(texts).replace(/\s+/g, ' ').trim();
        return (
          <button
            key={`free-text-${boxId}`}
            type="button"
            aria-label={`Edit added text: ${label}`}
            title={label}
            onClick={() => {
              setActiveBlock(null);
              setActiveBulletList(null);
              setPopoverTarget(null);
              setFreeTextSession({
                block: freeTextBlockFromEdits(texts),
                existing: texts,
                boxId,
              });
            }}
            className="absolute z-[28] cursor-text rounded-sm border border-transparent bg-transparent hover:border-violet-500 hover:bg-violet-300/10 focus:border-violet-600 focus:outline-none"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: Math.max(8, rect.height) }}
          />
        );
      })}

      {editMode && blocks.map((block, index) => {
        const list = bulletLists.find((entry) => entry.sourceBlock === block);
        const target = list ? bulletListHeadingBlock(list) : block;
        if (!target) return null;
        const existing = findExisting(target);
        if (!existing || existing.texts.length === 0) return null;
        const rect = pdfRectToScreenRect(
          textBoxRect(existing.texts),
          viewport,
          dpr,
        );
        return (
          <button
            key={`re-edit-${block.pageIndex}-${index}`}
            type="button"
            aria-label={`Text actions for edited text: ${sourceText(existing.texts).replace(/\s+/g, ' ').trim()}`}
            onClick={() => {
              setActiveBlock(null);
              setActiveBulletList(null);
              setPopoverTarget({ block: target, text: sourceText(existing.texts), screenRect: rect });
            }}
            className="absolute z-[25] cursor-text rounded-sm border border-transparent bg-transparent hover:border-emerald-500 focus:border-emerald-600 focus:outline-none"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: Math.max(8, rect.height) }}
          />
        );
      })}

      {editMode && popoverTarget && (
        <TapPopover
          key={`${popoverTarget.block.pageIndex}:${popoverTarget.screenRect.left}:${popoverTarget.screenRect.top}:${popoverTarget.text}`}
          text={popoverTarget.text}
          screenRect={popoverTarget.screenRect}
          pageWidth={viewport.width / dpr}
          onEdit={() => {
            setActiveBulletList(popoverTarget.bulletList ?? null);
            setBulletCommitError(undefined);
            setActiveBlock(
              popoverTarget.bulletList
                ? bulletEditorBlock(popoverTarget.bulletList)
                : popoverTarget.block,
            );
            setPopoverTarget(null);
          }}
          onClose={() => setPopoverTarget(null)}
        />
      )}

      {activeBlock && (() => {
        const existing = activeBulletList
          ? findExistingBulletList(activeBulletList)
          : findExisting(activeBlock);
        const sourceRect = existing && existing.texts.length > 0
          ? textBoxRect(existing.texts)
          : activeBulletList?.coverRect ?? activeBlock.rect;
        const screenRect = pdfRectToScreenRect(sourceRect, viewport, dpr);
        const activeCovers = activeBulletList
          ? [coverRectForBulletList(activeBulletList)]
          : coverRectsForTextBlock(activeBlock);
        const base = !activeBulletList && existing && existing.texts.length > 0
          ? {
              x: Math.min(...existing.texts.map((edit) => edit.rect.x)),
              topBaselineY: Math.max(...existing.texts.map((edit) => edit.rect.y)),
            }
          : undefined;
        const pageBottomY = page.view[1] ?? 0;
        const columnRun = activeBulletList
          ? contentBelowInColumn(blocks, imageRegions, activeBulletList, pageBottomY)
          : undefined;
        const bulletInitialHeight = activeBulletList && columnRun
          ? initialListHeight(activeBulletList, columnRun)
          : 0;
        const bulletMaxHeight = columnRun
          ? bulletInitialHeight + columnPushRoom(columnRun)
          : bulletInitialHeight;
        return (
          <>
            {activeCovers.map((cover, index) => {
              const rect = pdfRectToScreenRect(cover, viewport, dpr);
              return (
                <div
                  key={`active-cover-${index}`}
                  aria-label="Active text cover"
                  className="pointer-events-none absolute z-30"
                  style={{
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    backgroundColor: colorCss(sampleBackground(cover)),
                  }}
                />
              );
            })}
            <TextEditOverlay
              key={`${activeBlock.pageIndex}:${activeBlock.rect.x}:${activeBlock.rect.y}:${activeBlock.text}`}
              block={activeBlock}
              existing={existing?.texts}
              screenRect={screenRect}
              zoom={zoom}
              pageWidthPt={viewport.width / (zoom * dpr)}
              backgroundColor={colorCss(sampleBackground(activeBulletList?.coverRect ?? activeBlock.rect))}
              bulletMode={activeBulletList ? {
                items: activeBulletList.items.map((item) => item.text),
                maxHeightPt: bulletMaxHeight,
                noRoomMessage: 'No room on this page',
              } : undefined}
              externalError={bulletCommitError}
              onCancel={() => {
                setActiveBlock(null);
                setActiveBulletList(null);
                setBulletCommitError(undefined);
              }}
              onDone={(next) => {
                const nextZ = edits.reduce((max, edit) => Math.max(max, edit.z), 0) + 1;
                if (activeBulletList && columnRun) {
                  const items = wrapBulletItems(activeBulletList, next);
                  const probe = buildBulletListEdits(
                    activeBulletList,
                    next,
                    items,
                    nextZ,
                    bulletInitialHeight,
                  );
                  const pushPlan = planColumnPush(
                    probe.usedHeightPt,
                    bulletInitialHeight,
                    columnRun,
                  );
                  if (pushPlan.stopped) {
                    setBulletCommitError('No room on this page');
                    return;
                  }
                  const reflowKey = bulletReflowKey(activeBulletList);
                  const cascade = pushColumnEdits(
                    columnRun,
                    pushPlan.pushDeltaY,
                    nextZ,
                    reflowKey,
                  );
                  if (cascade.stopped) {
                    setBulletCommitError('No room on this page');
                    return;
                  }
                  const built = buildBulletListEdits(
                    activeBulletList,
                    next,
                    items,
                    nextZ + cascade.edits.length,
                    bulletMaxHeight,
                  );
                  if (built.overflow) {
                    setBulletCommitError('No room on this page');
                    return;
                  }
                  const activeEdits = [...built.covers, ...built.texts].map((edit) => ({
                    ...edit,
                    reflowKey,
                  }));
                  const removeIds = new Set(
                    edits
                      .filter((edit) => edit.reflowKey === reflowKey)
                      .map((edit) => edit.id),
                  );
                  if (existing) {
                    existing.covers.forEach((edit) => removeIds.add(edit.id));
                    existing.texts.forEach((edit) => removeIds.add(edit.id));
                  }
                  replaceEdits(
                    [...removeIds],
                    [...cascade.edits, ...activeEdits],
                  );
                  setActiveBlock(null);
                  setActiveBulletList(null);
                  setBulletCommitError(undefined);
                  return;
                }
                const wrappedLines = wrapNextText(next);
                const built = buildTextBlockEdits(
                  activeBlock,
                  next,
                  wrappedLines,
                  nextZ,
                  base,
                );
                replaceEdits(
                  existing
                    ? [...existing.covers.map((edit) => edit.id), ...existing.texts.map((edit) => edit.id)]
                    : [],
                  [...built.covers, ...built.texts],
                );
                setActiveBlock(null);
              }}
            />
          </>
        );
      })()}

      {freeTextSession && (() => {
        const { block, existing, boxId } = freeTextSession;
        const screenRect = pdfRectToScreenRect(block.rect, viewport, dpr);
        return (
          <TextEditOverlay
            key={`free-editor-${boxId ?? `${block.rect.x}:${block.rect.y}`}`}
            block={block}
            existing={existing}
            screenRect={screenRect}
            zoom={zoom}
            pageWidthPt={viewport.width / (zoom * dpr)}
            backgroundColor="transparent"
            onCancel={() => setFreeTextSession(null)}
            onDone={(next) => {
              if (next.text.trim() === '') {
                if (existing) replaceEdits(existing.map((edit) => edit.id), []);
                setFreeTextSession(null);
                return;
              }
              const wrappedLines = wrapNextText(next);
              const nextZ = edits.reduce((max, edit) => Math.max(max, edit.z), 0) + 1;
              const texts = buildFreeTextEdits(
                pageIndex,
                block.rect,
                next,
                wrappedLines,
                nextZ,
                boxId,
              );
              if (existing) replaceEdits(existing.map((edit) => edit.id), texts);
              else addEdits(texts);
              setFreeTextSession(null);
            }}
          />
        );
      })()}
    </div>
  );
}
