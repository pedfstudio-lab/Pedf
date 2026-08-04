import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { pdfRectToScreenRect, pdfToViewport } from '@/lib/export/coordinates';
import type { CoverEdit, PdfRect, Rgb, TextEdit } from '@/lib/export/types';
import { sampleDominantColor } from '@/lib/export/colorSample';
import {
  buildTextBlockEdits,
  coverRectForTextBlock,
  coverRectsForTextBlock,
} from '@/lib/edit/buildTextEdits';
import { wrapTextToLines } from '@/lib/edit/textLayout';
import { textStyleToCanvasFont, textStyleToCss } from '@/lib/edit/textStyleCss';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import type { TextBlock, TextRun } from '@/lib/pdf/textContent';
import { detectDates } from '@/lib/smart/dateDetect';
import { useDocumentStore } from '@/state/documentStore';
import { useEdits } from '@/state/editsStore';
import { SmartSpanLayer } from './SmartSpanLayer';
import { TapPopover } from './TapPopover';
import { TextEditOverlay } from './TextEditOverlay';

interface OverlayLayerProps {
  readonly page: PDFPageProxy;
  readonly pageIndex: number;
  readonly viewport: PageViewport;
  readonly dpr: number;
  readonly zoom: number;
  readonly editMode: boolean;
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
}

const WHITE_BACKGROUND: Rgb = { r: 1, g: 1, b: 1 };

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
  peek,
}: OverlayLayerProps) {
  const [runs, setRuns] = useState<TextRun[]>([]);
  const [blocks, setBlocks] = useState<TextBlock[]>([]);
  const [activeBlock, setActiveBlock] = useState<TextBlock | null>(null);
  const [popoverTarget, setPopoverTarget] = useState<PopoverTarget | null>(null);
  const { edits, replaceEdits } = useEdits();
  const { getPageCanvas } = useDocumentStore();

  useEffect(() => {
    let cancelled = false;
    void extractTextRuns(page, pageIndex).then((nextRuns) => {
      if (!cancelled) {
        setRuns(nextRuns);
        setBlocks(groupRunsIntoBlocks(nextRuns));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [page, pageIndex]);

  const detectedDates = useMemo(() => detectDates(runs), [runs]);

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
    const byZ = new Map(pageTextEdits.map((edit) => [edit.z, edit]));
    const texts: TextEdit[] = [];
    for (let z = anchor.z + coverCount; byZ.has(z); z += 1) {
      const text = byZ.get(z);
      if (text) texts.push(text);
    }
    return { covers: covers.length > 0 ? covers : [anchor], texts };
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
            {edit.text}
          </div>
        );
      })}

      <SmartSpanLayer dates={detectedDates} viewport={viewport} dpr={dpr} />

      {editMode && blocks.map((block, index) => {
        const rect = pdfRectToScreenRect(block.rect, viewport, dpr);
        const labelText = block.text.replace(/\s+/g, ' ').trim();
        const existing = findExisting(block);
        const actionText = existing && existing.texts.length > 0
          ? sourceText(existing.texts)
          : block.text;
        return (
          <button
            key={`${block.pageIndex}-${index}-${block.rect.x}-${block.rect.y}`}
            type="button"
            aria-label={`Text actions: ${labelText}`}
            title={labelText}
            onClick={() => {
              setActiveBlock(null);
              setPopoverTarget({ block, text: actionText, screenRect: rect });
            }}
            className="absolute z-20 cursor-text rounded-sm border border-transparent bg-transparent hover:border-blue-400 hover:bg-blue-300/20 focus:border-blue-500 focus:bg-blue-300/20 focus:outline-none"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: Math.max(8, rect.height) }}
          />
        );
      })}

      {editMode && blocks.map((block, index) => {
        const existing = findExisting(block);
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
              setPopoverTarget({ block, text: sourceText(existing.texts), screenRect: rect });
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
            setActiveBlock(popoverTarget.block);
            setPopoverTarget(null);
          }}
          onClose={() => setPopoverTarget(null)}
        />
      )}

      {activeBlock && (() => {
        const existing = findExisting(activeBlock);
        const sourceRect = existing && existing.texts.length > 0
          ? textBoxRect(existing.texts)
          : activeBlock.rect;
        const screenRect = pdfRectToScreenRect(sourceRect, viewport, dpr);
        const activeCovers = coverRectsForTextBlock(activeBlock);
        const base = existing && existing.texts.length > 0
          ? {
              x: Math.min(...existing.texts.map((edit) => edit.rect.x)),
              topBaselineY: Math.max(...existing.texts.map((edit) => edit.rect.y)),
            }
          : undefined;
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
              backgroundColor={colorCss(sampleBackground(activeBlock.rect))}
              onCancel={() => setActiveBlock(null)}
              onDone={(next) => {
                const canvas = window.document.createElement('canvas');
                const context = canvas.getContext('2d');
                if (context) context.font = textStyleToCanvasFont(next.style);
                const wrappedLines = wrapTextToLines(
                  next.text,
                  next.width,
                  (text) => context?.measureText(text).width ?? text.length * next.style.fontSizePt * 0.55,
                );
                const nextZ = edits.reduce((max, edit) => Math.max(max, edit.z), 0) + 1;
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
    </div>
  );
}
