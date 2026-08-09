import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { pdfRectToScreenRect, screenRectToPdfRect } from '@/lib/export/coordinates';
import type { CoverEdit, ImageEdit, PdfRect } from '@/lib/export/types';
import { capturePdfRegion, cropImageBytes } from '@/lib/images/imageCrop';
import { fitImageRect, imageMimeType } from '@/lib/images/imageFile';
import {
  isRasterTextRegion,
  sampleImageRichness,
  shouldKeepImageRegion,
} from '@/lib/images/imageRichness';
import { sampleOutsideImage } from '@/lib/images/outsideBackground';
import { detectImageCandidates } from '@/lib/pdf/images';
import type { ImageRegion } from '@/lib/pdf/images';
import { useDocumentStore } from '@/state/documentStore';
import { useEdits } from '@/state/editsStore';

interface ImageOverlayProps {
  readonly page: PDFPageProxy;
  readonly pageIndex: number;
  readonly viewport: PageViewport;
  readonly dpr: number;
  readonly imageMode: boolean;
}

interface PendingTarget {
  readonly kind: 'add' | 'replace';
  readonly rect: PdfRect;
}

interface ImageDraft {
  readonly bytes: Uint8Array;
  readonly rect: PdfRect;
}

type CropTarget =
  | { readonly kind: 'added'; readonly edit: ImageEdit }
  | { readonly kind: 'existing'; readonly region: ImageRegion };

interface ScreenSelection {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const MIN_DRAW_SIZE_PX = 8;

function id(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  const epsilon = 0.01;
  return (
    Math.abs(left.x - right.x) <= epsilon &&
    Math.abs(left.y - right.y) <= epsilon &&
    Math.abs(left.w - right.w) <= epsilon &&
    Math.abs(left.h - right.h) <= epsilon
  );
}

function imageBlob(bytes: Uint8Array): Blob {
  const mime = imageMimeType(bytes);
  if (!mime) throw new Error('Unsupported image format. Choose a PNG or JPEG file.');
  return new Blob([bytes.slice().buffer], { type: mime });
}

async function readImageDimensions(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const blob = imageBlob(bytes);
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('The selected image could not be decoded.'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ImagePreview({
  bytes,
  rect,
  viewport,
  dpr,
  className,
}: {
  readonly bytes: Uint8Array;
  readonly rect: PdfRect;
  readonly viewport: PageViewport;
  readonly dpr: number;
  readonly className: string;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(imageBlob(bytes));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes]);
  const screen = pdfRectToScreenRect(rect, viewport, dpr);
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      className={className}
      style={{
        left: screen.left,
        top: screen.top,
        width: screen.width,
        height: screen.height,
      }}
    />
  );
}

function targetRect(target: CropTarget): PdfRect {
  return target.kind === 'added' ? target.edit.rect : target.region.rect;
}

export function ImageOverlay({ page, pageIndex, viewport, dpr, imageMode }: ImageOverlayProps) {
  const { edits, addEdits, removeEdit, updateEdit } = useEdits();
  const { getPageCanvas } = useDocumentStore();
  const [regions, setRegions] = useState<ImageRegion[]>([]);
  const [drawRect, setDrawRect] = useState<ScreenSelection>();
  const [draft, setDraft] = useState<ImageDraft>();
  const [cropTarget, setCropTarget] = useState<CropTarget>();
  const [cropRect, setCropRect] = useState<PdfRect>();
  const [cropDragRect, setCropDragRect] = useState<ScreenSelection>();
  const [cropBusy, setCropBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingTargetRef = useRef<PendingTarget>();

  useEffect(() => {
    let cancelled = false;
    void detectImageCandidates(page, pageIndex)
      .then((candidates) => {
        if (cancelled) return;
        const registration = getPageCanvas(pageIndex);
        const diagnostics = candidates.map((candidate) => ({
          candidate,
          richness: registration
            ? sampleImageRichness(
                registration.canvas,
                registration.viewport,
                candidate.region.rect,
              )
            : undefined,
        }));
        const next = diagnostics
          .filter(({ candidate, richness }) => {
            return shouldKeepImageRegion(
              richness?.rich ?? true,
              candidate.hasText,
              candidate.paragraph,
              richness ? isRasterTextRegion(richness) : false,
            );
          })
          .map(({ candidate }) => candidate.region);
        setRegions(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => { cancelled = true; };
  }, [getPageCanvas, page, pageIndex]);

  useEffect(() => {
    if (!imageMode) {
      setDraft(undefined);
      setCropTarget(undefined);
      setCropRect(undefined);
      setCropDragRect(undefined);
    }
  }, [imageMode]);

  const pageImages = useMemo(
    () => edits
      .filter((edit): edit is ImageEdit => edit.kind === 'image' && edit.pageIndex === pageIndex)
      .sort((left, right) => left.z - right.z),
    [edits, pageIndex],
  );
  const coveredOriginals = useMemo(
    () => edits.filter(
      (edit): edit is CoverEdit =>
        edit.kind === 'cover' &&
        edit.pageIndex === pageIndex &&
        /^image-(cover|delete-cover|crop-cover)-/.test(edit.id),
    ),
    [edits, pageIndex],
  );
  const visibleRegions = useMemo(
    () => regions.filter(
      (region) => !coveredOriginals.some((cover) => sameRect(cover.rect, region.rect)),
    ),
    [coveredOriginals, regions],
  );

  const nextZ = () => edits.reduce((maximum, edit) => Math.max(maximum, edit.z), 0) + 1;
  const makeExistingCover = (rect: PdfRect, prefix: string, z: number): CoverEdit => {
    const registration = getPageCanvas(pageIndex);
    const color = registration
      ? sampleOutsideImage(
          registration.canvas,
          registration.viewport,
          rect,
          Math.max(3, Math.round(4 * registration.dpr)),
        )
      : { r: 1, g: 1, b: 1 };
    return {
      id: id(prefix),
      kind: 'cover',
      pageIndex,
      rect,
      z,
      color,
      sampleBackground: false,
    };
  };

  const chooseFile = (target: PendingTarget) => {
    pendingTargetRef.current = target;
    setError(undefined);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const target = pendingTargetRef.current;
    pendingTargetRef.current = undefined;
    if (!file || !target) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!imageMimeType(bytes)) {
        throw new Error('Unsupported image format. Choose a PNG or JPEG file.');
      }
      const size = await readImageDimensions(bytes);
      const rect = fitImageRect(target.rect, size.width, size.height);
      if (target.kind === 'add') {
        setDraft({ bytes, rect });
        return;
      }
      const z = nextZ();
      const cover = makeExistingCover(target.rect, 'image-cover', z);
      const image: ImageEdit = {
        id: id('image-replacement'),
        kind: 'image',
        pageIndex,
        rect,
        z: z + 1,
        bytes,
      };
      addEdits([cover, image]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const beginDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || draft || cropTarget) return;
    event.preventDefault();
    const surface = event.currentTarget;
    const bounds = surface.getBoundingClientRect();
    const start = {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height),
    };
    let latest = { left: start.x, top: start.y, width: 0, height: 0 };
    setDrawRect(latest);
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
      setDrawRect(latest);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', cancel);
      setDrawRect(undefined);
      if (latest.width >= MIN_DRAW_SIZE_PX && latest.height >= MIN_DRAW_SIZE_PX) {
        chooseFile({ kind: 'add', rect: screenRectToPdfRect(latest, viewport, dpr) });
      }
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', cancel);
      setDrawRect(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', cancel);
  };

  const beginDraftTransform = (
    mode: 'move' | 'resize',
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (!draft) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = pdfRectToScreenRect(draft.rect, viewport, dpr);
    const pageWidth = viewport.width / dpr;
    const pageHeight = viewport.height / dpr;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      let next = start;
      if (mode === 'move') {
        next = {
          ...start,
          left: clamp(start.left + dx, 0, Math.max(0, pageWidth - start.width)),
          top: clamp(start.top + dy, 0, Math.max(0, pageHeight - start.height)),
        };
      } else {
        const requested = Math.max(
          (start.width + dx) / start.width,
          (start.height + dy) / start.height,
          12 / start.width,
          12 / start.height,
        );
        const maximum = Math.min(
          (pageWidth - start.left) / start.width,
          (pageHeight - start.top) / start.height,
        );
        const scale = Math.min(requested, maximum);
        next = { ...start, width: start.width * scale, height: start.height * scale };
      }
      const rect = screenRectToPdfRect(next, viewport, dpr);
      setDraft((current) => current ? { ...current, rect } : current);
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

  const startCrop = (target: CropTarget) => {
    setError(undefined);
    setCropTarget(target);
    setCropRect(undefined);
    setCropDragRect(undefined);
  };

  const beginCropDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !cropTarget || cropBusy) return;
    event.preventDefault();
    event.stopPropagation();
    const surface = event.currentTarget;
    const bounds = surface.getBoundingClientRect();
    const original = pdfRectToScreenRect(targetRect(cropTarget), viewport, dpr);
    const start = {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height),
    };
    let latest = { left: start.x, top: start.y, width: 0, height: 0 };
    setCropDragRect(latest);
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
      setCropDragRect(latest);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      if (latest.width >= MIN_DRAW_SIZE_PX && latest.height >= MIN_DRAW_SIZE_PX) {
        setCropRect(screenRectToPdfRect({
          left: original.left + latest.left,
          top: original.top + latest.top,
          width: latest.width,
          height: latest.height,
        }, viewport, dpr));
      }
      setCropDragRect(undefined);
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      setCropDragRect(undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  };

  const confirmCrop = async () => {
    if (!cropTarget || !cropRect || cropBusy) return;
    setCropBusy(true);
    setError(undefined);
    try {
      if (cropTarget.kind === 'added') {
        const bytes = await cropImageBytes(cropTarget.edit.bytes, cropTarget.edit.rect, cropRect);
        updateEdit({ ...cropTarget.edit, rect: cropRect, bytes });
      } else {
        const bytes = await capturePdfRegion(page, cropRect, 3);
        const z = nextZ();
        const cover = makeExistingCover(cropTarget.region.rect, 'image-crop-cover', z);
        const image: ImageEdit = {
          id: id('image-cropped-existing'),
          kind: 'image',
          pageIndex,
          rect: cropRect,
          z: z + 1,
          bytes,
        };
        addEdits([cover, image]);
      }
      setCropTarget(undefined);
      setCropRect(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCropBusy(false);
    }
  };

  const draftScreen = draft ? pdfRectToScreenRect(draft.rect, viewport, dpr) : undefined;
  const cropTargetScreen = cropTarget
    ? pdfRectToScreenRect(targetRect(cropTarget), viewport, dpr)
    : undefined;
  const cropSelectionScreen = cropRect
    ? pdfRectToScreenRect(cropRect, viewport, dpr)
    : undefined;

  return (
    <div className="pointer-events-none absolute inset-0 z-30" aria-label={`Image overlays for page ${pageIndex + 1}`}>
      {pageImages.map((edit, index) => {
        const screen = pdfRectToScreenRect(edit.rect, viewport, dpr);
        return (
          <div key={edit.id}>
            <ImagePreview
              bytes={edit.bytes}
              rect={edit.rect}
              viewport={viewport}
              dpr={dpr}
              className="pointer-events-none absolute z-10 object-fill"
            />
            {imageMode && !draft && !cropTarget && (
              <div
                className="pointer-events-auto absolute z-40 border-2 border-cyan-600 bg-cyan-300/5"
                style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height }}
                aria-label={`Added image ${index + 1} on page ${pageIndex + 1}`}
              >
                <button
                  type="button"
                  aria-label={`Delete added image ${index + 1} on page ${pageIndex + 1}`}
                  title="Delete image"
                  onClick={(event) => {
                    event.stopPropagation();
                    removeEdit(edit.id);
                  }}
                  className="absolute -right-3 -top-3 z-20 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-red-600 text-sm font-bold leading-none text-white shadow hover:bg-red-500"
                >
                  ×
                </button>
                <button
                  type="button"
                  aria-label={`Crop added image ${index + 1} on page ${pageIndex + 1}`}
                  title="Crop image"
                  onClick={(event) => {
                    event.stopPropagation();
                    startCrop({ kind: 'added', edit });
                  }}
                  className="absolute bottom-1 left-1 z-20 rounded bg-cyan-800 px-2 py-1 text-[11px] font-semibold text-white shadow hover:bg-cyan-700"
                >
                  Crop
                </button>
              </div>
            )}
          </div>
        );
      })}

      {imageMode && !draft && !cropTarget && (
        <div
          className="pointer-events-auto absolute inset-0 z-20 cursor-crosshair bg-cyan-300/5"
          onPointerDown={beginDraw}
          aria-label={`Draw image region on page ${pageIndex + 1}`}
        />
      )}

      {imageMode && !draft && !cropTarget && visibleRegions.map((region, index) => {
        const screen = pdfRectToScreenRect(region.rect, viewport, dpr);
        return (
          <div
            key={`${index}:${region.rect.x}:${region.rect.y}`}
            className="pointer-events-auto absolute z-30 rounded-sm border-2 border-amber-500 bg-amber-300/10"
            style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height }}
          >
            <button
              type="button"
              aria-label={`Replace image ${index + 1} on page ${pageIndex + 1}`}
              title="Replace this image"
              onClick={(event) => {
                event.stopPropagation();
                chooseFile({ kind: 'replace', rect: region.rect });
              }}
              className="absolute inset-0 z-0 rounded-sm bg-transparent hover:bg-amber-300/20 focus:outline focus:outline-2 focus:outline-amber-600"
            />
            <button
              type="button"
              aria-label={`Delete existing image ${index + 1} on page ${pageIndex + 1}`}
              title="Delete image"
              onClick={(event) => {
                event.stopPropagation();
                addEdits([makeExistingCover(region.rect, 'image-delete-cover', nextZ())]);
              }}
              className="absolute -right-3 -top-3 z-20 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-red-600 text-sm font-bold leading-none text-white shadow hover:bg-red-500"
            >
              ×
            </button>
            <button
              type="button"
              aria-label={`Crop existing image ${index + 1} on page ${pageIndex + 1}`}
              title="Crop image"
              onClick={(event) => {
                event.stopPropagation();
                startCrop({ kind: 'existing', region });
              }}
              className="absolute bottom-1 left-1 z-20 rounded bg-amber-700 px-2 py-1 text-[11px] font-semibold text-white shadow hover:bg-amber-600"
            >
              Crop
            </button>
          </div>
        );
      })}

      {drawRect && (
        <div
          className="absolute z-40 border-2 border-dashed border-cyan-600 bg-cyan-300/20"
          style={drawRect}
        />
      )}

      {imageMode && !draft && !cropTarget && (
        <div className="absolute left-3 top-3 z-50 rounded-md bg-neutral-900/90 px-3 py-2 text-xs font-medium text-white shadow">
          Drag to add, tap amber to replace, or use Crop / ×.
        </div>
      )}

      {draft && (
        <ImagePreview
          bytes={draft.bytes}
          rect={draft.rect}
          viewport={viewport}
          dpr={dpr}
          className="pointer-events-none absolute z-50 object-fill"
        />
      )}

      {draft && draftScreen && (
        <div
          className="pointer-events-auto absolute z-50 outline outline-2 outline-cyan-600"
          style={{
            left: draftScreen.left,
            top: draftScreen.top,
            width: draftScreen.width,
            height: draftScreen.height,
          }}
        >
          <button
            type="button"
            aria-label="Move added image"
            title="Drag to move"
            onPointerDown={(event) => beginDraftTransform('move', event)}
            className="absolute inset-0 z-10 cursor-move bg-transparent"
          />
          <button
            type="button"
            aria-label="Resize added image"
            title="Drag to resize"
            onPointerDown={(event) => beginDraftTransform('resize', event)}
            className="absolute -bottom-2 -right-2 z-30 h-5 w-5 cursor-nwse-resize rounded-full border-2 border-white bg-cyan-600 shadow"
          />
          <div className={`absolute left-0 z-40 flex gap-1 rounded-md bg-white p-1 shadow-lg ${draftScreen.top > 44 ? 'bottom-full mb-2' : 'top-full mt-2'}`}>
            <button
              type="button"
              onClick={() => setDraft(undefined)}
              className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const image: ImageEdit = {
                  id: id('image-added'),
                  kind: 'image',
                  pageIndex,
                  rect: draft.rect,
                  z: nextZ(),
                  bytes: draft.bytes,
                };
                addEdits([image]);
                setDraft(undefined);
              }}
              className="rounded bg-cyan-700 px-2 py-1 text-xs font-semibold text-white hover:bg-cyan-600"
            >
              Confirm
            </button>
          </div>
        </div>
      )}

      {cropTarget && cropTargetScreen && (
        <div
          className="pointer-events-auto absolute z-[70] cursor-crosshair overflow-visible border-2 border-violet-600 bg-black/25"
          style={{
            left: cropTargetScreen.left,
            top: cropTargetScreen.top,
            width: cropTargetScreen.width,
            height: cropTargetScreen.height,
          }}
          onPointerDown={beginCropDraw}
          aria-label={`Draw crop region on ${cropTarget.kind} image on page ${pageIndex + 1}`}
        >
          {(cropDragRect || cropSelectionScreen) && (() => {
            const selection = cropDragRect ?? {
              left: (cropSelectionScreen?.left ?? 0) - cropTargetScreen.left,
              top: (cropSelectionScreen?.top ?? 0) - cropTargetScreen.top,
              width: cropSelectionScreen?.width ?? 0,
              height: cropSelectionScreen?.height ?? 0,
            };
            return (
              <div
                className="pointer-events-none absolute border-2 border-dashed border-white bg-transparent shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]"
                style={selection}
              />
            );
          })()}
          <div className="pointer-events-none absolute left-2 top-2 rounded bg-violet-950/90 px-2 py-1 text-[11px] font-medium text-white">
            Drag inside the image to choose the crop.
          </div>
          <div
            className={`absolute left-0 z-20 flex gap-1 rounded-md bg-white p-1 shadow-lg ${cropTargetScreen.top > 48 ? 'bottom-full mb-2' : 'top-full mt-2'}`}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              disabled={cropBusy}
              onClick={() => {
                setCropTarget(undefined);
                setCropRect(undefined);
              }}
              className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!cropRect || cropBusy}
              onClick={() => void confirmCrop()}
              className="rounded bg-violet-700 px-2 py-1 text-xs font-semibold text-white hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cropBusy ? 'Cropping…' : 'Confirm crop'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="pointer-events-auto absolute bottom-3 left-3 z-[80] max-w-xs rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 shadow">
          {error}
          <button type="button" onClick={() => setError(undefined)} className="ml-2 font-bold" aria-label="Dismiss image error">×</button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        aria-label={`Choose image file for page ${pageIndex + 1}`}
        onChange={(event) => void handleFile(event)}
      />
    </div>
  );
}
