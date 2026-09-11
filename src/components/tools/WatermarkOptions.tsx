import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { PDFDocument, type PDFPage } from 'pdf-lib';
import { useElementSize } from '@/lib/edit/floatingToolbar';
import { readerFrame } from '@/lib/pdf/readerFrame';
import { HEIC_GUIDANCE, isHeicFile } from '@/lib/tools/files';
import { prepareImageForPdf } from '@/lib/tools/jpgToPdf';
import { loadPdfJs, savePdf } from '@/lib/tools/pdfIo';
import { selectedPageIndices } from '@/lib/tools/pdfToJpgOptions';
import type { ToolOptionsProps } from '@/lib/tools/types';
import { prepareWatermarkAssets, watermarkPage, type WatermarkGeometry } from '@/lib/tools/watermark';
import { centreRange } from '@/lib/tools/watermarkLayout';
import {
  parseWatermarkOptions,
  WATERMARK_COLOURS,
  watermarkProblem,
  type WatermarkAngle,
  type WatermarkColour,
  type WatermarkFont,
  type WatermarkMode,
  type WatermarkOptionsValue,
  type WatermarkPageSelection,
  type WatermarkPosition,
  type WatermarkSize,
} from '@/lib/tools/watermarkOptions';

type PreviewStatus = 'empty' | 'loading' | 'ready' | 'failed';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_SIZE_ERROR = 'Choose an image smaller than 10 MB.';
/** Long side of the preview stage in CSS pixels. */
const STAGE_LONG_SIDE = 400;
/** Snap to the page centre / edges within this share of the page. */
const SNAP = 0.02;
const NUDGE = 0.01;
const NUDGE_BIG = 0.05;
const CSS_FONTS: Record<WatermarkFont, string> = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};
const positions: readonly { value: Exclude<WatermarkPosition, 'tile' | 'custom'>; label: string; symbol: string }[] = [
  { value: 'tl', label: 'Top left', symbol: '↖' },
  { value: 't', label: 'Top centre', symbol: '↑' },
  { value: 'tr', label: 'Top right', symbol: '↗' },
  { value: 'l', label: 'Middle left', symbol: '←' },
  { value: 'c', label: 'Centre', symbol: '•' },
  { value: 'r', label: 'Middle right', symbol: '→' },
  { value: 'bl', label: 'Bottom left', symbol: '↙' },
  { value: 'b', label: 'Bottom centre', symbol: '↓' },
  { value: 'br', label: 'Bottom right', symbol: '↘' },
];

/** A rendered page picture plus the page size as the reader sees it (points). */
interface RenderedPage { url: string; width: number; height: number; geometry?: WatermarkGeometry }
interface RealPreview extends RenderedPage { geometry: WatermarkGeometry; forValue: WatermarkOptionsValue }
/** Limits for the stamp's centre, as shares of the page (y from the top). */
interface Limits { minX: number; maxX: number; minY: number; maxY: number }
interface DragState { x: number; y: number; snapX: boolean; snapY: boolean }

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** Snap near the centre lines and the edge limits, then keep the whole stamp on the page. */
function snapSpot(x: number, y: number, limits: Limits): DragState {
  let snapX = false;
  let snapY = false;
  if (Math.abs(x - 0.5) < SNAP) { x = 0.5; snapX = true; }
  else if (Math.abs(x - limits.minX) < SNAP) x = limits.minX;
  else if (Math.abs(x - limits.maxX) < SNAP) x = limits.maxX;
  if (Math.abs(y - 0.5) < SNAP) { y = 0.5; snapY = true; }
  else if (Math.abs(y - limits.minY) < SNAP) y = limits.minY;
  else if (Math.abs(y - limits.maxY) < SNAP) y = limits.maxY;
  return { x: clamp(x, limits.minX, limits.maxX), y: clamp(y, limits.minY, limits.maxY), snapX, snapY };
}

function cssColour(colour: WatermarkColour): string {
  const [r, g, b] = WATERMARK_COLOURS[colour].map((channel) => Math.round(channel * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

async function preparedDimensions(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer], { type: mime }));
  try { return { width: bitmap.width, height: bitmap.height }; } finally { bitmap.close(); }
}

/**
 * Copy one page into a new one-page PDF, optionally watermark it with the real `watermarkPage`, and render it
 * with pdf.js (print intent, so it finishes in a background tab). Resolves `undefined` when cancelled.
 */
async function renderPreviewPage(
  source: PDFDocument,
  pageIndex: number,
  decorate: ((doc: PDFDocument, page: PDFPage) => Promise<WatermarkGeometry>) | undefined,
  register: (task: { cancel(): void }) => void,
  cancelled: () => boolean,
): Promise<RenderedPage | undefined> {
  const doc = await PDFDocument.create();
  const [copied] = await doc.copyPages(source, [pageIndex]);
  if (!copied) throw new Error('Preview page unavailable.');
  const page = doc.addPage(copied);
  const frame = readerFrame(page);
  const geometry = decorate ? await decorate(doc, page) : undefined;
  const bytes = await savePdf(doc);
  if (cancelled()) return undefined;
  const loaded = await loadPdfJs(new File([bytes.slice().buffer], 'watermark-preview.pdf', { type: 'application/pdf' }));
  let rendered: Awaited<ReturnType<typeof loaded.doc.getPage>> | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    rendered = await loaded.doc.getPage(1);
    const natural = rendered.getViewport({ scale: 1 });
    const longSide = STAGE_LONG_SIDE * Math.min(2, window.devicePixelRatio || 1);
    const viewport = rendered.getViewport({ scale: longSide / Math.max(natural.width, natural.height) });
    canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const task = rendered.render({ canvasContext: context, viewport, intent: 'print' });
    register(task);
    await task.promise;
    if (cancelled()) return undefined;
    return { url: canvas.toDataURL('image/png'), width: frame.width, height: frame.height, geometry };
  } finally {
    rendered?.cleanup();
    if (canvas) canvas.width = canvas.height = 0;
    await loaded.doc.destroy().catch(() => {});
  }
}

export function WatermarkOptions({ options, onChange, inputs, disabled }: ToolOptionsProps) {
  const value = useMemo(() => parseWatermarkOptions(options), [options]);
  const file = inputs[0];
  const imageInput = useRef<HTMLInputElement>(null);
  const source = useRef<{ file: File; doc: PDFDocument } | null>(null);
  const stageElement = useRef<HTMLDivElement | null>(null);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [base, setBase] = useState<RenderedPage | null>(null);
  const [real, setReal] = useState<RealPreview | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('empty');
  const [drag, setDrag] = useState<DragState | null>(null);
  const [imageError, setImageError] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [measureStage, stageSize] = useElementSize<HTMLDivElement>();
  const setStage = useCallback((node: HTMLDivElement | null) => {
    stageElement.current = node;
    measureStage(node);
  }, [measureStage]);
  const update = (next: Partial<WatermarkOptionsValue>) => onChange({ ...value, ...next });
  const problem = watermarkProblem(value);
  const pageIndex = useMemo(() => {
    if (!pageCount) return 0;
    try {
      return selectedPageIndices({ pageSelection: value.pageSelection, ranges: value.ranges }, pageCount)[0] ?? 0;
    } catch { return 0; }
  }, [pageCount, value.pageSelection, value.ranges]);

  useEffect(() => {
    let cancelled = false;
    source.current = null;
    setPageCount(0);
    setBase(null);
    setReal(null);
    setPreviewStatus(file ? 'loading' : 'empty');
    if (!file) return;
    void (async () => {
      try {
        const doc = await PDFDocument.load(await file.arrayBuffer());
        if (cancelled) return;
        source.current = { file, doc };
        setPageCount(doc.getPageCount());
        setSourceVersion((version) => version + 1);
      } catch { if (!cancelled) setPreviewStatus('failed'); }
    })();
    return () => { cancelled = true; };
  }, [file]);

  // The plain page picture (no watermark): shown under the stamp while it is dragged or while the real preview updates.
  useEffect(() => {
    const cached = source.current;
    if (!file || !cached || cached.file !== file) return;
    let cancelled = false;
    let task: { cancel(): void } | undefined;
    void renderPreviewPage(cached.doc, pageIndex, undefined, (active) => { task = active; }, () => cancelled)
      .then((result) => { if (result && !cancelled) setBase(result); })
      .catch(() => {});
    return () => { cancelled = true; task?.cancel(); };
  }, [file, pageIndex, sourceVersion]);

  // The real result for the first chosen page, debounced: the same watermarkPage() the tool runs.
  useEffect(() => {
    const cached = source.current;
    if (!file || !cached || cached.file !== file) return;
    if (problem) {
      setReal(null);
      setPreviewStatus('empty');
      return;
    }
    let cancelled = false;
    let task: { cancel(): void } | undefined;
    const timer = window.setTimeout(() => {
      setPreviewStatus('loading');
      void renderPreviewPage(
        cached.doc,
        pageIndex,
        async (doc, page) => watermarkPage(page, value, await prepareWatermarkAssets(doc, value)),
        (active) => { task = active; },
        () => cancelled,
      ).then((result) => {
        if (!result?.geometry || cancelled) return;
        setReal({ ...result, geometry: result.geometry, forValue: value });
        setPreviewStatus('ready');
      }).catch((error: unknown) => {
        if (!cancelled && !(error instanceof Error && error.name === 'RenderingCancelledException')) {
          setPreviewStatus('failed');
        }
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
  }, [file, pageIndex, problem, sourceVersion, value]);

  useEffect(() => {
    if (!value.imageBytes || !value.imageMime) { setThumbnailUrl(''); return; }
    const url = URL.createObjectURL(new Blob([value.imageBytes.slice().buffer], { type: value.imageMime }));
    setThumbnailUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value.imageBytes, value.imageMime]);

  // Where the stamp's centre is, as shares of the page (y from the top), and how far it may go.
  const geometry = real?.geometry;
  const handle = useMemo(() => {
    if (!geometry || value.position === 'tile' || problem) return null;
    const { pageWidth, pageHeight, itemWidth, itemHeight, angle } = geometry;
    const range = centreRange(pageWidth, pageHeight, itemWidth, itemHeight, angle);
    const limits: Limits = {
      minX: range.minX / pageWidth,
      maxX: range.maxX / pageWidth,
      minY: 1 - range.maxY / pageHeight,
      maxY: 1 - range.minY / pageHeight,
    };
    let x: number;
    let y: number;
    if (value.position === 'custom') {
      x = clamp(value.customX, limits.minX, limits.maxX);
      y = clamp(value.customY, limits.minY, limits.maxY);
    } else {
      const start = geometry.placements[0];
      if (!start) return null;
      const radians = angle * Math.PI / 180;
      const cx = start.u + (itemWidth * Math.cos(radians) - itemHeight * Math.sin(radians)) / 2;
      const cy = start.v + (itemWidth * Math.sin(radians) + itemHeight * Math.cos(radians)) / 2;
      x = cx / pageWidth;
      y = 1 - cy / pageHeight;
    }
    return {
      x,
      y,
      limits,
      angle,
      widthShare: itemWidth / pageWidth,
      heightShare: itemHeight / pageHeight,
      fontShare: geometry.fontSize / pageWidth,
    };
  }, [geometry, problem, value.customX, value.customY, value.position]);

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || !handle || event.button !== 0) return;
    const rect = stageElement.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is only a nicety (keeps the drag if the pointer leaves the window); the window listeners below
      // track the drag either way, so a refused capture must not stop it.
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { x: handle.x, y: handle.y };
    const { limits } = handle;
    let latest: DragState = { ...origin, snapX: false, snapY: false };
    let moved = false;
    setDrag(latest);
    const move = (moveEvent: PointerEvent) => {
      moved = true;
      latest = snapSpot(
        origin.x + (moveEvent.clientX - startX) / rect.width,
        origin.y + (moveEvent.clientY - startY) / rect.height,
        limits,
      );
      setDrag(latest);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
    };
    const finish = () => {
      cleanup();
      // A click without moving keeps the chosen quick spot.
      if (moved) update({ position: 'custom', customX: latest.x, customY: latest.y });
      setDrag(null);
    };
    const cancel = () => {
      cleanup();
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  };

  const nudge = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!handle) return;
    const step = event.shiftKey ? NUDGE_BIG : NUDGE;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    update({
      position: 'custom',
      customX: clamp(handle.x + dx, handle.limits.minX, handle.limits.maxX),
      customY: clamp(handle.y + dy, handle.limits.minY, handle.limits.maxY),
    });
  };

  async function chooseImage(selected?: File) {
    if (!selected) return;
    setImageError('');
    if (isHeicFile(selected)) { setImageError(HEIC_GUIDANCE); return; }
    if (selected.size > MAX_IMAGE_BYTES) { setImageError(IMAGE_SIZE_ERROR); return; }
    try {
      const prepared = await prepareImageForPdf(selected);
      const dimensions = await preparedDimensions(prepared.bytes, prepared.mime);
      update({
        mode: 'image',
        imageBytes: prepared.bytes,
        imageMime: prepared.mime,
        imageName: selected.name,
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
      });
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'This image could not be read.');
    }
  }

  // The real picture when it matches the current options; otherwise the plain page with a live copy of the stamp.
  const fresh = !!real && real.forValue === value && previewStatus !== 'loading' && !drag;
  const stageImage = fresh ? real.url : base?.url ?? real?.url;
  const pageSize = base ?? real;
  const spot = drag ?? handle;
  const previewMessage = previewStatus === 'loading' ? 'Updating preview…'
    : previewStatus === 'failed' ? 'Preview unavailable'
      : file ? 'Preview will appear when the watermark is ready.' : 'Choose a PDF to preview the watermark.';
  const ghost = !fresh && handle ? (value.mode === 'image'
    ? (thumbnailUrl ? <img className="watermark-ghost-image" src={thumbnailUrl} alt="" draggable={false}
      style={{ opacity: value.opacity }} /> : null)
    : <span className="watermark-ghost-text" style={{
      fontFamily: CSS_FONTS[value.font],
      fontWeight: value.bold ? 700 : 400,
      fontSize: `${handle.fontShare * stageSize.width}px`,
      color: cssColour(value.colour),
      opacity: value.opacity,
    }}>{value.text}</span>) : null;

  return <fieldset className="tool-options watermark-options" disabled={disabled}>
    <legend>Watermark</legend>
    <div className="watermark-mode" aria-label="Watermark type">
      {(['text', 'image'] as const).map((mode: WatermarkMode) => <button key={mode} type="button"
        aria-pressed={value.mode === mode} onClick={() => update({ mode })}>
        {mode === 'text' ? 'Text' : 'Image'}
      </button>)}
    </div>
    <p className="tool-hint watermark-over-note">Adds a semi-transparent stamp over your pages.</p>

    {value.mode === 'text' ? <div className="watermark-section">
      <label className="tool-select-field">Watermark text
        <input type="text" maxLength={100} value={value.text} onChange={(event) => update({ text: event.target.value })} />
      </label>
      <div className="tool-select-grid">
        <label className="tool-select-field">Font
          <select value={value.font} onChange={(event) => update({ font: event.target.value as WatermarkFont })}>
            <option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option>
          </select>
        </label>
        <label className="tool-select-field">Size
          <select value={String(value.size)} onChange={(event) => update({
            size: event.target.value === 'auto' ? 'auto' : Number(event.target.value) as WatermarkSize,
          })}>
            <option value="auto">Auto</option>{[24, 36, 48, 72].map((size) => <option key={size} value={size}>{size} pt</option>)}
          </select>
        </label>
      </div>
      <label className="tool-checkbox"><input type="checkbox" checked={value.bold}
        onChange={(event) => update({ bold: event.target.checked })} />Bold</label>
      <span className="watermark-label">Colour</span>
      <div className="watermark-colours" role="group" aria-label="Watermark colour">
        {(Object.keys(WATERMARK_COLOURS) as WatermarkColour[]).map((colour) => <button key={colour} type="button"
          className={`watermark-colour watermark-colour-${colour}`} aria-label={`${colour} watermark colour`}
          aria-pressed={value.colour === colour} onClick={() => update({ colour })} />)}
      </div>
    </div> : <div className="watermark-section">
      <input ref={imageInput} className="watermark-file-input" type="file"
        accept="image/png,image/jpeg,image/webp"
        onClick={(event) => { event.currentTarget.value = ''; }}
        onChange={(event) => { void chooseImage(event.target.files?.[0]); }} />
      {!value.imageBytes ? <button className="tool-secondary watermark-choose-image" type="button"
        onClick={() => imageInput.current?.click()}>Choose image…</button> : <div className="watermark-image-row">
        <img src={thumbnailUrl} alt="Watermark thumbnail" />
        <div><strong>{value.imageName}</strong><span>{value.imageWidth} × {value.imageHeight} px</span></div>
        <button className="tool-secondary" type="button" onClick={() => update({
          imageBytes: undefined, imageMime: undefined, imageName: undefined, imageWidth: undefined, imageHeight: undefined,
        })}>Remove</button>
      </div>}
      {imageError && <p className="tool-error watermark-inline-error" role="alert">{imageError}</p>}
      <label className="watermark-range"><span>Width: <strong>{Math.round(value.imageScale * 100)}%</strong> of the page</span>
        <input type="range" min="10" max="100" step="1" value={Math.round(value.imageScale * 100)}
          onChange={(event) => update({ imageScale: Number(event.target.value) / 100 })} />
      </label>
    </div>}

    <div className="watermark-shared">
      <label className="watermark-range"><span>Opacity: <strong>{Math.round(value.opacity * 100)}%</strong></span>
        <input type="range" min="10" max="100" step="1" value={Math.round(value.opacity * 100)}
          onChange={(event) => update({ opacity: Number(event.target.value) / 100 })} />
      </label>
      <label className="tool-select-field">Angle
        <select value={String(value.angle)} onChange={(event) => update({ angle: Number(event.target.value) as WatermarkAngle })}>
          <option value="45">Diagonal 45°</option><option value="0">Horizontal</option>
          <option value="-45">Diagonal −45°</option><option value="90">Vertical 90°</option>
        </select>
      </label>
      <div><span className="watermark-label">Quick spots</span>
        <div className="watermark-positions" role="group" aria-label="Watermark position">
          {positions.map((position) => <button key={position.value} type="button" title={position.label}
            aria-label={position.label} aria-pressed={value.position === position.value}
            disabled={value.position === 'tile'}
            onClick={() => update({ position: position.value })}>{position.symbol}</button>)}
        </div>
        <label className="tool-checkbox"><input type="checkbox" checked={value.position === 'tile'}
          onChange={(event) => update({ position: event.target.checked ? 'tile' : 'c' })} />Tile across page</label>
      </div>
      <div className="tool-option-details tool-page-selection">
        <label htmlFor="watermark-pages">Pages</label>
        <select id="watermark-pages" value={value.pageSelection}
          onChange={(event) => update({ pageSelection: event.target.value as WatermarkPageSelection })}>
          <option value="all">All pages</option><option value="custom">Only these pages</option>
        </select>
        {value.pageSelection === 'custom' && <>
          <label htmlFor="watermark-ranges">Pages or ranges</label>
          <input id="watermark-ranges" type="text" inputMode="numeric" value={value.ranges}
            placeholder="1-3, 5, 8-10" onChange={(event) => update({ ranges: event.target.value })} />
          <p className="tool-hint">Use commas between pages or ranges.</p>
        </>}
      </div>
    </div>

    <div className="watermark-preview" aria-busy={previewStatus === 'loading'}>
      {pageSize && stageImage ? <div ref={setStage} className="watermark-stage" style={{
        width: `min(100%, ${Math.round(STAGE_LONG_SIDE * pageSize.width / Math.max(pageSize.width, pageSize.height))}px)`,
        aspectRatio: `${pageSize.width} / ${pageSize.height}`,
      }}>
        <img src={stageImage} alt={fresh ? 'Watermarked page preview' : 'Page preview'} draggable={false} />
        {drag?.snapX && <span className="watermark-guide watermark-guide-v" aria-hidden="true" />}
        {drag?.snapY && <span className="watermark-guide watermark-guide-h" aria-hidden="true" />}
        {handle && spot && <button type="button"
          className={`watermark-handle${drag ? ' is-dragging' : ''}`}
          style={{
            left: `${spot.x * 100}%`,
            top: `${spot.y * 100}%`,
            width: `${handle.widthShare * 100}%`,
            height: `${handle.heightShare * 100}%`,
            transform: `translate(-50%, -50%) rotate(${-handle.angle}deg)`,
          }}
          aria-label="Move the watermark. Drag it, or use the arrow keys."
          title="Drag to place the watermark"
          onPointerDown={beginDrag}
          onKeyDown={nudge}>
          {ghost}
        </button>}
      </div> : <span>{previewMessage}</span>}
    </div>
    {handle && <p className="tool-hint watermark-drag-hint">Drag the stamp anywhere on the page. It snaps to the centre.</p>}
    {problem && <p className="tool-hint watermark-problem">{problem}</p>}
  </fieldset>;
}
