import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from 'react';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { pdfRectToScreenRect, screenRectToPdfRect } from '@/lib/export/coordinates';
import type { ScreenRect } from '@/lib/export/coordinates';
import type { CoverEdit, ImageEdit, PdfRect } from '@/lib/export/types';
import { capturePdfRegion, cropImageBytes } from '@/lib/images/imageCrop';
import { cropSourceImage, prepareSourceImageCrops } from '@/lib/images/cropSourceImage';
import { extractImageBytes } from '@/lib/images/extractImage';
import { coverImageRect, fitImageRect, imageMimeType } from '@/lib/images/imageFile';
import {
  isRasterTextRegion,
  sampleImageRichness,
  shouldKeepImageRegion,
} from '@/lib/images/imageRichness';
import { sampleDeleteImageCover, sampleOutsideImage } from '@/lib/images/outsideBackground';
import { isRegionCovered } from '@/lib/images/regionCovered';
import { toolbarOffsetInFrame, useElementSize } from '@/lib/edit/floatingToolbar';
import type { ElementSize } from '@/lib/edit/floatingToolbar';
import { replacedImageFor } from '@/lib/edit/replacedImage';
import {
  isBackgroundRegion,
  moveScreenRect,
  POINTS_PER_MM,
  resizePdfRectByMillimetres,
  useImageRectTransform,
} from '@/lib/images/useImageRectTransform';
import { detectImageCandidates } from '@/lib/pdf/images';
import type { DrawnImage, ImageRegion } from '@/lib/pdf/images';
import { useDocumentStore } from '@/state/documentStore';
import { useEdits } from '@/state/editsStore';

interface ImageOverlayProps {
  readonly page?: PDFPageProxy;
  readonly pageIndex: number;
  readonly viewport: PageViewport;
  readonly dpr: number;
  readonly imageMode: boolean;
  readonly directMode: boolean;
}

type PendingTarget =
  | { readonly kind: 'add'; readonly rect: PdfRect }
  | { readonly kind: 'replace'; readonly region: ImageRegion }
  | { readonly kind: 'reimage'; readonly editId: string; readonly rect: PdfRect };

interface ImageDraft {
  readonly bytes: Uint8Array;
  readonly rect: PdfRect;
}

type ImageTransformSelection =
  | {
      readonly kind: 'existing';
      readonly region: ImageRegion;
      readonly bytes: Uint8Array;
      readonly rect: PdfRect;
      readonly warning?: string;
    }
  | {
      readonly kind: 'placed';
      readonly editId: string;
      readonly bytes: Uint8Array;
      readonly rect: PdfRect;
    };

interface SizeDraft {
  readonly field: 'width' | 'height';
  readonly text: string;
}

interface PendingDirectDrag {
  readonly id: number;
  readonly start: ScreenRect;
  dx: number;
  dy: number;
  dragging: boolean;
  appliedDx?: number;
  appliedDy?: number;
}

type CropTarget =
  | { readonly kind: 'added'; readonly edit: ImageEdit }
  | { readonly kind: 'existing'; readonly region: ImageRegion; readonly draw?: DrawnImage };

interface ScreenSelection {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const MIN_DRAW_SIZE_PX = 8;
const DRAG_THRESHOLD_PX = 5;
const RERENDER_WARNING = 'Moved image was re-rendered; it may be slightly softer.';
const CANNOT_MOVE_ERROR = "This image can't be moved";
const RESIZE_HANDLE_CLASSES = {
  nw: '-left-2 -top-2 cursor-nwse-resize',
  ne: '-right-2 -top-2 cursor-nesw-resize',
  sw: '-bottom-2 -left-2 cursor-nesw-resize',
  se: '-bottom-2 -right-2 cursor-nwse-resize',
} as const;

function id(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
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

function sameRect(left: PdfRect | undefined, right: PdfRect): boolean {
  return !!left && ['x', 'y', 'w', 'h'].every((key) => (
    Math.abs(left[key as keyof PdfRect] - right[key as keyof PdfRect]) <= 0.01
  ));
}

export function ImageOverlay({
  page,
  pageIndex,
  viewport,
  dpr,
  imageMode,
  directMode,
}: ImageOverlayProps) {
  const { edits, addEdits, removeEdit, replaceEdits, updateEdit } = useEdits();
  const { document: openDocument, getPageCanvas } = useDocumentStore();
  const [regions, setRegions] = useState<ImageRegion[]>([]);
  const [regionDraws, setRegionDraws] = useState<DrawnImage[]>([]);
  const [drawRect, setDrawRect] = useState<ScreenSelection>();
  const [draft, setDraft] = useState<ImageDraft>();
  const [transformSelection, setTransformSelection] = useState<ImageTransformSelection>();
  const [sizeDraft, setSizeDraft] = useState<SizeDraft>();
  const [transformBusy, setTransformBusy] = useState(false);
  const [cropTarget, setCropTarget] = useState<CropTarget>();
  const [cropRect, setCropRect] = useState<PdfRect>();
  const [cropDragRect, setCropDragRect] = useState<ScreenSelection>();
  const [cropBusy, setCropBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingTargetRef = useRef<PendingTarget>();
  const transformFrameRef = useRef<HTMLDivElement>(null);
  const transformSelectionRef = useRef<ImageTransformSelection>();
  const pendingDragRef = useRef<PendingDirectDrag>();
  const directGestureIdRef = useRef(0);
  const directGestureCleanupRef = useRef<() => void>();

  const setDraftRect = useCallback<Dispatch<SetStateAction<PdfRect | undefined>>>((next) => {
    setDraft((current) => {
      if (!current) return current;
      const rect = typeof next === 'function' ? next(current.rect) : next;
      return rect ? { ...current, rect } : undefined;
    });
  }, []);
  const setTransformRect = useCallback<Dispatch<SetStateAction<PdfRect | undefined>>>((next) => {
    setTransformSelection((current) => {
      if (!current) return current;
      const rect = typeof next === 'function' ? next(current.rect) : next;
      return rect ? { ...current, rect } : undefined;
    });
  }, []);
  const draftTransform = useImageRectTransform({ rect: draft?.rect, setRect: setDraftRect, viewport, dpr });
  const selectedTransform = useImageRectTransform({
    rect: transformSelection?.rect,
    setRect: setTransformRect,
    viewport,
    dpr,
  });
  const pageRect = useMemo(
    () => screenRectToPdfRect(
      { left: 0, top: 0, width: viewport.width / dpr, height: viewport.height / dpr },
      viewport,
      dpr,
    ),
    [dpr, viewport],
  );
  const pageSizePx: ElementSize = { width: viewport.width / dpr, height: viewport.height / dpr };
  // Floating toolbars are measured so they can be kept inside the page box, which clips overflow.
  const [draftToolbarRef, draftToolbarSize] = useElementSize<HTMLDivElement>();
  const [transformToolbarRef, transformToolbarSize] = useElementSize<HTMLDivElement>();
  const [cropToolbarRef, cropToolbarSize] = useElementSize<HTMLDivElement>();
  const applyPendingDirectDrag = useCallback((gestureId: number) => {
    const pending = pendingDragRef.current;
    if (
      !transformSelectionRef.current ||
      !pending ||
      pending.id !== gestureId ||
      !pending.dragging ||
      (pending.appliedDx === pending.dx && pending.appliedDy === pending.dy)
    ) return;
    pending.appliedDx = pending.dx;
    pending.appliedDy = pending.dy;
    const moved = moveScreenRect(
      pending.start,
      pending.dx,
      pending.dy,
      viewport.width / dpr,
      viewport.height / dpr,
    );
    setTransformRect(screenRectToPdfRect(moved, viewport, dpr));
  }, [dpr, setTransformRect, viewport]);

  useEffect(() => {
    transformSelectionRef.current = transformSelection;
    if (transformSelection) {
      const gestureId = pendingDragRef.current?.id;
      if (gestureId !== undefined) applyPendingDirectDrag(gestureId);
    }
  }, [applyPendingDirectDrag, transformSelection]);

  useEffect(() => () => directGestureCleanupRef.current?.(), []);

  useEffect(() => {
    if (!page) {
      setRegions([]);
      setRegionDraws([]);
      return;
    }
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
          .map(({ candidate }) => candidate);
        setRegions(next.map((candidate) => candidate.region));
        setRegionDraws(next.flatMap((candidate) => candidate.draw ? [candidate.draw] : []));
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => { cancelled = true; };
  }, [getPageCanvas, page, pageIndex]);

  useEffect(() => {
    if (!imageMode || !openDocument) return;
    void prepareSourceImageCrops(openDocument.loaded.originalBytes).catch(() => undefined);
  }, [imageMode, openDocument]);

  useEffect(() => {
    if (imageMode) return;
    setDraft(undefined);
    setCropTarget(undefined);
    setCropRect(undefined);
    setCropDragRect(undefined);
  }, [imageMode]);

  useEffect(() => {
    if (imageMode || directMode) return;
    pendingDragRef.current = undefined;
    setTransformSelection(undefined);
  }, [directMode, imageMode]);

  useEffect(() => () => directGestureCleanupRef.current?.(), []);

  useEffect(() => {
    setSizeDraft(undefined);
  }, [transformSelection]);

  useEffect(() => {
    if (!directMode || !transformSelection) return;
    const cancelOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && transformFrameRef.current?.contains(target)) return;
      pendingDragRef.current = undefined;
      setTransformSelection(undefined);
    };
    document.addEventListener('pointerdown', cancelOutside);
    return () => document.removeEventListener('pointerdown', cancelOutside);
  }, [directMode, transformSelection]);

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
        /^image-(cover|delete-cover|crop-cover|move-cover)-/.test(edit.id),
    ),
    [edits, pageIndex],
  );
  const visibleRegions = useMemo(
    () => regions.filter(
      (region) => !coveredOriginals.some((cover) => isRegionCovered(cover.rect, region.rect)),
    ),
    [coveredOriginals, regions],
  );

  const nextZ = () => edits.reduce((maximum, edit) => Math.max(maximum, edit.z), 0) + 1;
  const makeExistingCover = (
    region: ImageRegion,
    prefix: string,
    z: number,
  ): CoverEdit => {
    const rect = region.rect;
    const registration = getPageCanvas(pageIndex);
    const deleteSample = registration && (
      prefix === 'image-delete-cover' || prefix === 'image-move-cover'
    )
      ? sampleDeleteImageCover(registration.canvas, registration.viewport, rect, {
          probeWidthPx: Math.max(2, Math.round(2 * registration.dpr)),
          pageRingInnerPx: Math.max(24, Math.round(24 * registration.dpr)),
          pageRingOuterPx: Math.max(40, Math.round(40 * registration.dpr)),
          maxExpansionPx: Math.max(40, Math.round(40 * registration.dpr)),
        })
      : undefined;
    const color = deleteSample?.color ?? (registration
      ? sampleOutsideImage(
          registration.canvas,
          registration.viewport,
          rect,
          Math.max(3, Math.round(4 * registration.dpr)),
        )
      : { r: 1, g: 1, b: 1 });
    return {
      id: id(prefix),
      kind: 'cover',
      pageIndex,
      rect: deleteSample?.rect ?? rect,
      z,
      color,
      sampleBackground: false,
      replacesImages: [replacedImageFor(region, regionDraws)],
    };
  };

  const startPlacedTransform = (edit: ImageEdit) => {
    setError(undefined);
    setTransformSelection({
      kind: 'placed',
      editId: edit.id,
      bytes: edit.bytes,
      rect: edit.rect,
    });
  };

  const startExistingTransform = async (region: ImageRegion) => {
    if (!page || !openDocument || transformBusy) return;
    setError(undefined);
    setTransformBusy(true);
    try {
      const pdf = await PDFDocument.load(openDocument.loaded.originalBytes.slice(), {
        updateMetadata: false,
      });
      const extracted = extractImageBytes(pdf, pageIndex, region.rect);
      if (extracted) {
        setTransformSelection({
          kind: 'existing',
          region,
          bytes: extracted.bytes,
          rect: region.rect,
        });
        return;
      }
      const bytes = await capturePdfRegion(page, region.rect, 2);
        setTransformSelection({
          kind: 'existing',
          region,
          bytes,
        rect: region.rect,
        warning: RERENDER_WARNING,
      });
    } catch {
      setError(CANNOT_MOVE_ERROR);
    } finally {
      setTransformBusy(false);
    }
  };

  const beginDirectPress = (
    event: ReactPointerEvent<HTMLButtonElement>,
    rect: PdfRect,
    select: () => void | Promise<void>,
  ) => {
    if (!directMode || event.button !== 0) return;
    event.stopPropagation();
    directGestureCleanupRef.current?.();
    const gestureId = directGestureIdRef.current + 1;
    directGestureIdRef.current = gestureId;

    if (event.pointerType === 'touch') {
      pendingDragRef.current = undefined;
      void select();
      return;
    }

    event.preventDefault();
    const pending: PendingDirectDrag = {
      id: gestureId,
      start: pdfRectToScreenRect(rect, viewport, dpr),
      dx: 0,
      dy: 0,
      dragging: false,
    };
    pendingDragRef.current = pending;
    const selection = select();
    void Promise.resolve(selection).then(() => applyPendingDirectDrag(gestureId));
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;

    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      if (directGestureCleanupRef.current === cleanup) directGestureCleanupRef.current = undefined;
    };
    const move = (moveEvent: PointerEvent) => {
      const current = pendingDragRef.current;
      if (!current || current.id !== gestureId) return;
      current.dx = moveEvent.clientX - startX;
      current.dy = moveEvent.clientY - startY;
      if (!current.dragging && Math.hypot(current.dx, current.dy) < DRAG_THRESHOLD_PX) return;
      current.dragging = true;
      applyPendingDirectDrag(gestureId);
    };
    const finish = () => {
      cleanup();
      applyPendingDirectDrag(gestureId);
    };
    const cancel = () => {
      cleanup();
      if (pendingDragRef.current?.id === gestureId) pendingDragRef.current = undefined;
      setTransformSelection(undefined);
    };
    directGestureCleanupRef.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  };

  const confirmTransform = () => {
    const selection = transformSelection;
    if (!selection) return;
    if (selection.kind === 'placed') {
      const edit = edits.find(
        (candidate): candidate is ImageEdit => candidate.kind === 'image' && candidate.id === selection.editId,
      );
      if (edit) updateEdit({ ...edit, rect: selection.rect });
    } else {
      const z = nextZ();
      const cover = makeExistingCover(selection.region, 'image-move-cover', z);
      const image: ImageEdit = {
        id: id('image-moved-existing'),
        kind: 'image',
        pageIndex,
        rect: selection.rect,
        z: z + 1,
        bytes: selection.bytes,
      };
      addEdits([cover, image]);
    }
    setTransformSelection(undefined);
  };

  const setExactSize = (dimension: 'width' | 'height', millimetres: number) => {
    setTransformRect((current) => current
      ? resizePdfRectByMillimetres(current, pageRect, dimension, millimetres)
      : current);
  };

  const commitSizeDraft = (field: 'width' | 'height') => {
    if (!sizeDraft || sizeDraft.field !== field) return;
    const value = Number(sizeDraft.text);
    if (Number.isFinite(value) && value > 0) setExactSize(field, value);
    setSizeDraft(undefined);
  };

  const handleSizeKey = (
    field: 'width' | 'height',
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commitSizeDraft(field);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setSizeDraft(undefined);
    }
  };

  const handleTransformKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setTransformSelection(undefined);
      return;
    }
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmTransform();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const distance = event.shiftKey ? 10 : 1;
    const dx = event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0;
    const dy = event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0;
    selectedTransform.nudge(dx, dy);
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
      if (target.kind === 'add') {
        const rect = fitImageRect(target.rect, size.width, size.height);
        setDraft({ bytes, rect });
        return;
      }
      const targetRect = target.kind === 'replace' ? target.region.rect : target.rect;
      const coverRect = coverImageRect(targetRect, size.width, size.height);
      const croppedBytes = await cropImageBytes(bytes, coverRect, targetRect);
      if (target.kind === 'reimage') {
        const existing = edits.find(
          (edit): edit is ImageEdit => edit.kind === 'image' && edit.id === target.editId,
        );
        if (!existing) throw new Error('The image being replaced is no longer available.');
        replaceEdits([existing.id], [{
          ...existing,
          id: id('image-replacement'),
          rect: targetRect,
          bytes: croppedBytes,
        }]);
        return;
      }
      const z = nextZ();
      const cover = makeExistingCover(target.region, 'image-cover', z);
      const image: ImageEdit = {
        id: id('image-replacement'),
        kind: 'image',
        pageIndex,
        rect: target.region.rect,
        z: z + 1,
        bytes: croppedBytes,
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
        if (!page) throw new Error('Cannot crop source content on a blank page.');
        const sourceBytes = openDocument && cropTarget.draw
          ? await cropSourceImage(
              openDocument.loaded.originalBytes,
              cropTarget.draw,
              cropRect,
            )
          : undefined;
        const bytes = sourceBytes ?? await capturePdfRegion(page, cropRect, 3);
        const z = nextZ();
        const cover = makeExistingCover(cropTarget.region, 'image-crop-cover', z);
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
  const transformScreen = transformSelection
    ? pdfRectToScreenRect(transformSelection.rect, viewport, dpr)
    : undefined;
  const cropTargetScreen = cropTarget
    ? pdfRectToScreenRect(targetRect(cropTarget), viewport, dpr)
    : undefined;
  const cropSelectionScreen = cropRect
    ? pdfRectToScreenRect(cropRect, viewport, dpr)
    : undefined;
  /** Toolbar position relative to its frame, chosen so the whole bar stays on the page. */
  const toolbarOffset = (frame: ScreenRect, size: ElementSize) => toolbarOffsetInFrame(frame, size, pageSizePx);
  const draftToolbar = draftScreen ? toolbarOffset(draftScreen, draftToolbarSize) : undefined;
  const transformToolbar = transformScreen
    ? toolbarOffset(transformScreen, transformToolbarSize)
    : undefined;
  const cropToolbar = cropTargetScreen ? toolbarOffset(cropTargetScreen, cropToolbarSize) : undefined;

  return (
    <div className="pointer-events-none absolute inset-0 z-30" aria-label={`Image overlays for page ${pageIndex + 1}`}>
      {pageImages.map((edit, index) => {
        const screen = pdfRectToScreenRect(edit.rect, viewport, dpr);
        return (
          <div key={edit.id}>
            {!(transformSelection?.kind === 'placed' && transformSelection.editId === edit.id) && (
              <ImagePreview
                bytes={edit.bytes}
                rect={edit.rect}
                viewport={viewport}
                dpr={dpr}
                className="pointer-events-none absolute z-10 object-fill"
              />
            )}
            {imageMode && !draft && !cropTarget && !transformSelection && (
              <div
                className="pointer-events-auto absolute z-40 border-2 border-cyan-600 bg-cyan-300/5"
                style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height }}
                aria-label={`Added image ${index + 1} on page ${pageIndex + 1}`}
              >
                <button
                  type="button"
                  aria-label={`Move or resize added image ${index + 1} on page ${pageIndex + 1}`}
                  title="Move or resize image"
                  onClick={(event) => {
                    event.stopPropagation();
                    startPlacedTransform(edit);
                  }}
                  className="absolute inset-0 z-0 cursor-move bg-transparent"
                />
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
                <div className="absolute bottom-1 left-1 z-20 flex gap-1">
                  <button
                    type="button"
                    aria-label={`Crop added image ${index + 1} on page ${pageIndex + 1}`}
                    title="Crop image"
                    onClick={(event) => {
                      event.stopPropagation();
                      startCrop({ kind: 'added', edit });
                    }}
                    className="rounded bg-cyan-800 px-2 py-1 text-[11px] font-semibold text-white shadow hover:bg-cyan-700"
                  >
                    Crop
                  </button>
                  <button
                    type="button"
                    aria-label={`Replace added image ${index + 1} on page ${pageIndex + 1}`}
                    title="Replace image"
                    onClick={(event) => {
                      event.stopPropagation();
                      chooseFile({ kind: 'reimage', editId: edit.id, rect: edit.rect });
                    }}
                    className="rounded bg-cyan-800 px-2 py-1 text-[11px] font-semibold text-white shadow hover:bg-cyan-700"
                  >
                    Replace
                  </button>
                </div>
              </div>
            )}
            {directMode && !draft && !cropTarget && !transformSelection && (
              <button
                type="button"
                aria-label={`Move or resize added image ${index + 1} on page ${pageIndex + 1}`}
                title="Drag to move, click to select"
                onPointerDown={(event) => beginDirectPress(
                  event,
                  edit.rect,
                  () => startPlacedTransform(edit),
                )}
                className="pointer-events-auto absolute z-30 cursor-move rounded-sm bg-transparent hover:outline hover:outline-2 hover:outline-blue-400/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height }}
              />
            )}
          </div>
        );
      })}

      {imageMode && !draft && !cropTarget && !transformSelection && (
        <div
          className="pointer-events-auto absolute inset-0 z-20 cursor-crosshair bg-cyan-300/5"
          onPointerDown={beginDraw}
          aria-label={`Draw image region on page ${pageIndex + 1}`}
        />
      )}

      {imageMode && !draft && !cropTarget && !transformSelection && visibleRegions.map((region, index) => {
        const screen = pdfRectToScreenRect(region.rect, viewport, dpr);
        return (
          <div
            key={`${index}:${region.rect.x}:${region.rect.y}`}
            className="pointer-events-auto absolute z-30 rounded-sm border-2 border-amber-500 bg-amber-300/10"
            style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height }}
          >
            <button
              type="button"
              aria-label={`Move or resize image ${index + 1} on page ${pageIndex + 1}`}
              title="Move or resize image"
              onClick={(event) => {
                event.stopPropagation();
                void startExistingTransform(region);
              }}
              className="absolute inset-0 z-0 cursor-move rounded-sm bg-transparent hover:bg-amber-300/20 focus:outline focus:outline-2 focus:outline-amber-600"
            />
            <button
              type="button"
              aria-label={`Delete existing image ${index + 1} on page ${pageIndex + 1}`}
              title="Delete image"
              onClick={(event) => {
                event.stopPropagation();
                addEdits([makeExistingCover(
                  region,
                  'image-delete-cover',
                  nextZ(),
                )]);
              }}
              className="absolute -right-3 -top-3 z-20 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-red-600 text-sm font-bold leading-none text-white shadow hover:bg-red-500"
            >
              ×
            </button>
            <div className="absolute bottom-1 left-1 z-20 flex gap-1">
              <button
                type="button"
                aria-label={`Crop existing image ${index + 1} on page ${pageIndex + 1}`}
                title="Crop image"
                onClick={(event) => {
                  event.stopPropagation();
                  startCrop({
                    kind: 'existing',
                    region,
                    draw: regionDraws.find((candidate) => sameRect(candidate.visibleRect, region.rect)),
                  });
                }}
                className="rounded bg-amber-700 px-2 py-1 text-[11px] font-semibold text-white shadow hover:bg-amber-600"
              >
                Crop
              </button>
              <button
                type="button"
                aria-label={`Replace image ${index + 1} on page ${pageIndex + 1}`}
                title="Replace this image"
                onClick={(event) => {
                  event.stopPropagation();
                  chooseFile({ kind: 'replace', region });
                }}
                className="rounded bg-amber-700 px-2 py-1 text-[11px] font-semibold text-white shadow hover:bg-amber-600"
              >
                Replace
              </button>
            </div>
          </div>
        );
      })}

      {directMode && !draft && !cropTarget && !transformSelection && visibleRegions
        .filter((region) => !isBackgroundRegion(region.rect, pageRect))
        .map((region, index) => {
          const screen = pdfRectToScreenRect(region.rect, viewport, dpr);
          return (
            <button
              key={`direct:${index}:${region.rect.x}:${region.rect.y}`}
              type="button"
              aria-label={`Move or resize image ${index + 1} on page ${pageIndex + 1}`}
              title="Drag to move, click to select"
              onPointerDown={(event) => beginDirectPress(
                event,
                region.rect,
                () => startExistingTransform(region),
              )}
              className="pointer-events-auto absolute z-30 cursor-move rounded-sm bg-transparent hover:outline hover:outline-2 hover:outline-blue-400/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
              style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height }}
            />
          );
        })}

      {drawRect && (
        <div
          className="absolute z-40 border-2 border-dashed border-cyan-600 bg-cyan-300/20"
          style={drawRect}
        />
      )}

      {imageMode && !draft && !cropTarget && !transformSelection && (
        <div className="absolute left-3 top-3 z-50 rounded-md bg-neutral-900/90 px-3 py-2 text-xs font-medium text-white shadow">
          Drag to add, tap an image to move or resize, or use Crop / Replace / ×.
        </div>
      )}

      {transformBusy && (
        <div className="absolute left-3 top-3 z-[80] rounded-md bg-neutral-900/90 px-3 py-2 text-xs font-medium text-white shadow">
          Preparing image…
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
            onPointerDown={draftTransform.beginMove}
            className="absolute inset-0 z-10 cursor-move bg-transparent"
          />
          <button
            type="button"
            aria-label="Resize added image"
            title="Drag to resize"
            onPointerDown={(event) => draftTransform.beginResize('se', event)}
            className="absolute -bottom-2 -right-2 z-30 h-5 w-5 cursor-nwse-resize rounded-full border-2 border-white bg-cyan-600 shadow"
          />
          <div
            ref={draftToolbarRef}
            className="absolute z-40 flex gap-1 rounded-md bg-white p-1 shadow-lg"
            style={draftToolbar}
          >
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

      {transformSelection && transformScreen && (
        <>
          <ImagePreview
            bytes={transformSelection.bytes}
            rect={transformSelection.rect}
            viewport={viewport}
            dpr={dpr}
            className="pointer-events-none absolute z-50 object-fill"
          />
          <div
            ref={transformFrameRef}
            className="pointer-events-auto absolute z-[60] outline outline-2 outline-blue-600 focus:outline-4 focus:outline-blue-500"
            style={{
              left: transformScreen.left,
              top: transformScreen.top,
              width: transformScreen.width,
              height: transformScreen.height,
            }}
            tabIndex={0}
            autoFocus
            onKeyDown={handleTransformKey}
            aria-label="Selected image. Drag to move, use corner handles to resize, or use arrow keys to nudge."
          >
            <button
              type="button"
              aria-label="Move selected image"
              title="Drag to move"
              onPointerDown={selectedTransform.beginMove}
              className="absolute inset-0 z-10 cursor-move bg-transparent"
            />
            {(Object.keys(RESIZE_HANDLE_CLASSES) as Array<keyof typeof RESIZE_HANDLE_CLASSES>).map((corner) => (
              <button
                key={corner}
                type="button"
                aria-label={`Resize selected image from ${corner} corner`}
                title="Drag to resize proportionally"
                onPointerDown={(event) => selectedTransform.beginResize(corner, event)}
                className={`absolute z-30 h-5 w-5 rounded-full border-2 border-white bg-blue-600 shadow ${RESIZE_HANDLE_CLASSES[corner]}`}
              />
            ))}
            <div
              ref={transformToolbarRef}
              className="absolute z-40 flex min-w-max flex-wrap items-center gap-1.5 rounded-md border border-blue-200 bg-white p-2 text-xs text-neutral-700 shadow-xl"
              style={transformToolbar}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <label className="flex items-center gap-1 font-medium">
                W
                <input
                  aria-label="Image width in millimetres"
                  type="number"
                  min="7.1"
                  step="0.1"
                  value={sizeDraft?.field === 'width'
                    ? sizeDraft.text
                    : (transformSelection.rect.w / POINTS_PER_MM).toFixed(1)}
                  onChange={(event) => setSizeDraft({ field: 'width', text: event.target.value })}
                  onBlur={() => commitSizeDraft('width')}
                  onKeyDown={(event) => handleSizeKey('width', event)}
                  className="w-16 rounded border border-neutral-300 px-1.5 py-1 text-right"
                />
              </label>
              <span aria-hidden="true">×</span>
              <label className="flex items-center gap-1 font-medium">
                H
                <input
                  aria-label="Image height in millimetres"
                  type="number"
                  min="7.1"
                  step="0.1"
                  value={sizeDraft?.field === 'height'
                    ? sizeDraft.text
                    : (transformSelection.rect.h / POINTS_PER_MM).toFixed(1)}
                  onChange={(event) => setSizeDraft({ field: 'height', text: event.target.value })}
                  onBlur={() => commitSizeDraft('height')}
                  onKeyDown={(event) => handleSizeKey('height', event)}
                  className="w-16 rounded border border-neutral-300 px-1.5 py-1 text-right"
                />
              </label>
              <span className="mx-1 h-5 w-px bg-neutral-200" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setTransformSelection(undefined)}
                className="rounded px-2 py-1 text-neutral-600 hover:bg-neutral-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmTransform}
                className="rounded bg-blue-700 px-2 py-1 font-semibold text-white hover:bg-blue-600"
              >
                Done
              </button>
              {transformSelection.kind === 'existing' && transformSelection.warning && (
                <span className="basis-full text-[11px] text-amber-700" role="status">
                  {transformSelection.warning}
                </span>
              )}
            </div>
          </div>
        </>
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
            ref={cropToolbarRef}
            className="absolute z-20 flex gap-1 rounded-md bg-white p-1 shadow-lg"
            style={cropToolbar}
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
