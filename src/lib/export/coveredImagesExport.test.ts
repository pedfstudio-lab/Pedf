import { describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  concatTransformationMatrix,
  clip,
  drawObject,
  endPath,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  degrees,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { buildBulletListEdits } from '@/lib/edit/buildTextEdits';
import { replacedImageFor } from '@/lib/edit/replacedImage';
import { worstBlockDiff } from '@/harness/pixelDiff';
import { imageDrawsInContent } from '@/lib/images/extractImage';
import { detectBulletListFromRegions, formatBulletEditorText } from '@/lib/pdf/bulletList';
import { detectImageCandidates, imageRegionsFromOperatorList } from '@/lib/pdf/images';
import { deserializeProject, serializeProject } from '@/lib/projects/projectState';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { exportPdf } from './exportPdf';
import type { CoverEdit, Edit, EditDocument, PdfRect } from './types';

const optionalCanvas = await import('@napi-rs/canvas').catch(() => undefined);
const IMAGE = PDFName.of('Image');
const SUBTYPE = PDFName.of('Subtype');
const WIDTH = PDFName.of('Width');
const HEIGHT = PDFName.of('Height');
const BLACK_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function pngBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(BLACK_PIXEL_PNG_BASE64, 'base64'));
}

function geometry(pageIndex: number, widthPt = 240, heightPt = 220) {
  return { pageIndex, widthPt, heightPt, rotation: 0 as const, boxOffset: { x: 0, y: 0 } };
}

function cover(pageIndex: number, rect: PdfRect, id = 'image-delete-cover'): CoverEdit {
  const patch = {
    x: rect.x - 1,
    y: rect.y - 1,
    w: rect.w + 2,
    h: rect.h + 2,
  };
  return {
    id,
    kind: 'cover',
    pageIndex,
    rect: patch,
    z: 1,
    color: { r: 1, g: 1, b: 1 },
    sampleBackground: false,
    replacesImages: [{ kind: 'image', rect }],
  };
}

function rawPhoto(
  document: PDFDocument,
  width = 180,
  height = 140,
  transparency = false,
): PDFRef {
  let maskRef: PDFRef | undefined;
  if (transparency) {
    const mask = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: width, Height: height,
      ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    }), Uint8Array.from({ length: width * height }, (_, index) => index % 251));
    maskRef = document.context.register(mask);
  }
  const pixels = Uint8Array.from({ length: width * height * 3 }, (_, index) => (
    (index * 29 + Math.floor(index / 17) * 13) % 256
  ));
  const image = PDFRawStream.of(document.context.obj({
    Type: 'XObject', Subtype: 'Image', Width: width, Height: height,
    ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    ...(maskRef ? { SMask: maskRef } : {}),
  }), pixels);
  return document.context.register(image);
}

function drawRef(
  document: PDFDocument,
  pageIndex: number,
  ref: PDFRef,
  rect: PdfRect,
  tag = 'Photo',
): void {
  const page = document.getPage(pageIndex);
  const name = page.node.newXObject(tag, ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(rect.w, 0, 0, rect.h, rect.x, rect.y),
    drawObject(name),
    popGraphicsState(),
  );
}

function imageObjects(document: PDFDocument): Array<{
  readonly ref: PDFRef;
  readonly stream: PDFStream;
  readonly width?: number;
  readonly height?: number;
}> {
  return document.context.enumerateIndirectObjects().flatMap(([ref, object]) => {
    if (!(object instanceof PDFStream) || object.dict.get(SUBTYPE) !== IMAGE) return [];
    return [{
      ref,
      stream: object,
      width: object.dict.lookupMaybe(WIDTH, PDFNumber)?.asNumber(),
      height: object.dict.lookupMaybe(HEIGHT, PDFNumber)?.asNumber(),
    }];
  });
}

async function docFrom(document: PDFDocument, edits: Edit[]): Promise<EditDocument> {
  return {
    originalBytes: await document.save({ useObjectStreams: false }),
    pages: document.getPages().map((page, pageIndex) => geometry(pageIndex, page.getWidth(), page.getHeight())),
    edits,
  };
}

async function renderPage(bytes: Uint8Array, pageNumber: number): Promise<ImageData> {
  const createCanvas = optionalCanvas?.createCanvas;
  if (!createCanvas) throw new Error('Optional @napi-rs/canvas is unavailable.');
  const reader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  try {
    const page = await reader.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 150 / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      data: new Uint8ClampedArray(image.data),
      width: image.width,
      height: image.height,
      colorSpace: 'srgb',
    } as ImageData;
  } finally {
    await reader.destroy();
  }
}

function cropImageData(image: ImageData, rect: PdfRect, pageHeight: number): ImageData {
  const scale = 150 / 72;
  const left = Math.max(0, Math.floor(rect.x * scale));
  const top = Math.max(0, Math.floor((pageHeight - rect.y - rect.h) * scale));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.w) * scale));
  const bottom = Math.min(image.height, Math.ceil((pageHeight - rect.y) * scale));
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = ((top + y) * image.width + left) * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

async function textSnapshot(bytes: Uint8Array): Promise<unknown[]> {
  const reader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  try {
    const content = await (await reader.getPage(1)).getTextContent();
    return content.items.flatMap((item) => 'str' in item ? [[
      item.str,
      item.transform[4] ?? 0,
      item.transform[5] ?? 0,
    ]] : []);
  } finally {
    await reader.destroy();
  }
}

function overlapArea(left: PdfRect, right: PdfRect): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y),
  );
  return width * height;
}

async function trimmedPhotoBytes(): Promise<Uint8Array> {
  const source = await PDFDocument.create({ updateMetadata: false });
  const page = source.addPage([700, 800]);
  const photo = rawPhoto(source, 60, 88);
  const name = page.node.newXObject('TrimmedPhoto', photo);
  page.pushOperators(
    pushGraphicsState(),
    rectangle(50, 100, 600, 628),
    clip(),
    endPath(),
    concatTransformationMatrix(600, 0, 0, 880, 50, -26),
    drawObject(name),
    popGraphicsState(),
  );
  const font = await source.embedFont(StandardFonts.Helvetica);
  page.drawText('PARAGRAPH ABOVE THE VISIBLE PHOTO', {
    x: 80,
    y: 760,
    size: 14,
    font,
  });
  return source.save({ useObjectStreams: false });
}

async function editorDetectedPhotoDocument(
  rotation: 0 | 90 | 180 | 270 = 0,
): Promise<EditDocument> {
  const rects = [
    { x: 20, y: 35, w: 90, h: 140 },
    { x: 130, y: 35, w: 90, h: 140 },
  ];
  const source = await PDFDocument.create({ updateMetadata: false });
  const sourcePage = source.addPage([240, 220]);
  sourcePage.setRotation(degrees(rotation));
  drawRef(source, 0, rawPhoto(source, 360, 560), rects[0]!, 'LeftPhoto');
  drawRef(source, 0, rawPhoto(source, 360, 560), rects[1]!, 'RightPhoto');
  const originalBytes = await source.save({ useObjectStreams: false });
  const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
  let edits: CoverEdit[];
  try {
    const page = await reader.getPage(1);
    await page.getOperatorList({ annotationMode: 2 });
    const candidates = await detectImageCandidates(page, 0);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.draw?.objectId)).toBe(true);
    const draws = candidates.flatMap((candidate) => candidate.draw ? [candidate.draw] : []);
    edits = candidates.map((candidate, index) => ({
      ...cover(0, candidate.region.rect, `editor-image-cover-${index}`),
      replacesImages: [replacedImageFor(candidate.region, draws)],
    }));
  } finally {
    await reader.destroy();
  }

  return {
    originalBytes,
    pages: [{ pageIndex: 0, widthPt: 240, heightPt: 220, rotation, boxOffset: { x: 0, y: 0 } }],
    edits,
  };
}

describe('covered image export', () => {
  it('deletes a trimmed photo without covering text in its hidden placed area', async () => {
    const originalBytes = await trimmedPhotoBytes();
    const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
    let edit: CoverEdit;
    let paragraphRect: PdfRect;
    try {
      const page = await reader.getPage(1);
      await page.getOperatorList({ annotationMode: 2 });
      const candidates = await detectImageCandidates(page, 0);
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0]!;
      const paragraph = (await extractTextRuns(page, 0)).find((run) => (
        run.text.includes('PARAGRAPH ABOVE THE VISIBLE PHOTO')
      ));
      expect(paragraph).toBeDefined();
      if (!paragraph) throw new Error('paragraph fixture was not detected');
      paragraphRect = paragraph.rect;
      const draws = candidates.flatMap((entry) => entry.draw ? [entry.draw] : []);
      edit = {
        id: 'trimmed-photo-cover',
        kind: 'cover',
        pageIndex: 0,
        rect: { ...candidate.region.rect },
        z: 1,
        color: { r: 1, g: 1, b: 1 },
        sampleBackground: false,
        replacesImages: [replacedImageFor(candidate.region, draws)],
      };
      expect(edit.rect).toEqual({ x: 50, y: 100, w: 600, h: 628 });
      expect(overlapArea(edit.rect, paragraphRect)).toBe(0);
    } finally {
      await reader.destroy();
    }

    const exported = await exportPdf({
      originalBytes,
      pages: [geometry(0, 700, 800)],
      edits: [edit],
    });
    expect(exported.redaction).toMatchObject({
      removedImages: 1,
      unmatchedImages: 0,
      outsideCoverImages: 0,
      imageSkippedPages: 0,
    });
    expect(exported.warnings).toEqual([]);
    const reopened = await PDFDocument.load(exported.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toEqual([]);
    expect(imageObjects(reopened)).toHaveLength(0);
    expect(await textSnapshot(exported.bytes)).toEqual(await textSnapshot(originalBytes));
    if (optionalCanvas) {
      const [before, after] = await Promise.all([
        renderPage(originalBytes, 1),
        renderPage(exported.bytes, 1),
      ]);
      expect(worstBlockDiff(
        cropImageData(before, paragraphRect, 800),
        cropImageData(after, paragraphRect, 800),
      ).meanError).toBeLessThan(0.01);
    }
  });

  it('still removes a trimmed photo when a legacy cover records its placed rectangle', async () => {
    const originalBytes = await trimmedPhotoBytes();
    const placedRect = { x: 50, y: -26, w: 600, h: 880 };
    const exported = await exportPdf({
      originalBytes,
      pages: [geometry(0, 700, 800)],
      edits: [{
        id: 'legacy-placed-photo-cover',
        kind: 'cover',
        pageIndex: 0,
        rect: placedRect,
        z: 1,
        color: { r: 1, g: 1, b: 1 },
        sampleBackground: false,
        replacesImages: [{ kind: 'image', rect: placedRect }],
      }],
    });
    expect(exported.redaction).toMatchObject({ removedImages: 1, unmatchedImages: 0 });
    const reopened = await PDFDocument.load(exported.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toEqual([]);
    expect(imageObjects(reopened)).toHaveLength(0);
  });

  it('removes editor-detected photos after the screen has already evaluated the page', async () => {
    const doc = await editorDetectedPhotoDocument();
    const [baseline, removed] = await Promise.all([
      exportPdf(doc, { removeCoveredImages: false }),
      exportPdf(doc),
    ]);

    expect(removed.redaction).toMatchObject({
      removedImages: 2,
      unmatchedImages: 0,
      imageSkippedPages: 0,
    });
    expect(removed.warnings).toEqual([]);
    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toEqual([]);
    expect(imageObjects(reopened)).toHaveLength(0);
    expect(removed.bytes.byteLength).toBeLessThan(baseline.bytes.byteLength * 0.5);
  });

  it('removes the same detected photos after saving and reopening a project with a legacy id', async () => {
    const doc = await editorDetectedPhotoDocument();
    const plan = [{ id: 'source-0', kind: 'source' as const, sourceIndex: 0 }];
    const saved = serializeProject({
      past: [],
      present: { edits: doc.edits, plan },
      future: [],
    }, 0, 1) as unknown as {
      history: { present: { edits: Array<Record<string, unknown>> } };
    };
    const savedCover = saved.history.present.edits.find((edit) => edit.kind === 'cover');
    const savedReplacement = Array.isArray(savedCover?.replacesImages)
      ? savedCover.replacesImages[0]
      : undefined;
    if (savedReplacement && typeof savedReplacement === 'object') {
      (savedReplacement as Record<string, unknown>).objectId = 'img_p0_99';
    }
    const restored = deserializeProject(saved, 1);
    if (!restored.ok) throw new Error(restored.error);
    const restoredCover = restored.value.history.present.edits.find((edit) => edit.kind === 'cover');
    expect(restoredCover && restoredCover.kind === 'cover'
      ? restoredCover.replacesImages?.[0]
      : undefined).not.toHaveProperty('objectId');

    const removed = await exportPdf({
      ...doc,
      edits: [...restored.value.history.present.edits],
      plan: restored.value.history.present.plan,
    });
    expect(removed.redaction).toMatchObject({ removedImages: 2, unmatchedImages: 0 });
    expect(removed.warnings).toEqual([]);
    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toEqual([]);
    expect(imageObjects(reopened)).toHaveLength(0);
  });

  it('warns for an unmatched claim, keeps the picture, and still draws its cover', async () => {
    const photoRect = { x: 20, y: 35, w: 90, h: 140 };
    const missingRect = { x: 130, y: 35, w: 90, h: 140 };
    const source = await PDFDocument.create({ updateMetadata: false });
    source.addPage([240, 220]);
    drawRef(source, 0, rawPhoto(source, 120, 160), photoRect);
    const originalBytes = await source.save({ useObjectStreams: false });
    const missingCover: CoverEdit = {
      ...cover(0, missingRect, 'missing-image-cover'),
      color: { r: 1, g: 0, b: 0 },
    };
    const removed = await exportPdf({
      originalBytes,
      pages: [geometry(0)],
      edits: [missingCover],
    });

    expect(removed.redaction).toMatchObject({ removedImages: 0, unmatchedImages: 1 });
    expect(removed.warnings).toContain(
      'A deleted picture on page 1 could not be found in the file; '
      + 'it is still hidden under the cover but was not removed.',
    );
    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toHaveLength(1);
    expect(imageObjects(reopened)).toHaveLength(1);
    if (optionalCanvas) {
      const [before, after] = await Promise.all([renderPage(originalBytes, 1), renderPage(removed.bytes, 1)]);
      expect(worstBlockDiff(before, after).meanError).toBeGreaterThan(1);
    }
  });

  it.each([0, 90, 180, 270] as const)(
    'removes editor-detected photos from a page rotated %s degrees',
    async (rotation) => {
      const removed = await exportPdf(await editorDetectedPhotoDocument(rotation));
      expect(removed.redaction).toMatchObject({ removedImages: 2, unmatchedImages: 0 });
      expect(removed.warnings).toEqual([]);
      const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
      expect(imageDrawsInContent(reopened, 0)).toEqual([]);
      expect(imageObjects(reopened)).toHaveLength(0);
    },
  );

  it('physically deletes a covered photo, materially shrinks the file, and preserves pixels', async () => {
    const rect = { x: 25, y: 35, w: 180, h: 140 };
    const source = await PDFDocument.create({ updateMetadata: false });
    source.addPage([240, 220]);
    drawRef(source, 0, rawPhoto(source, 360, 280), rect);
    const doc = await docFrom(source, [cover(0, rect)]);
    const [baseline, removed] = await Promise.all([
      exportPdf(doc, { removeCoveredImages: false }),
      exportPdf(doc),
    ]);

    expect(removed.redaction).toMatchObject({ removedImages: 1, imageSkippedPages: 0 });
    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toEqual([]);
    expect(imageObjects(reopened)).toHaveLength(0);
    expect(removed.bytes.byteLength).toBeLessThan(baseline.bytes.byteLength * 0.5);
    if (optionalCanvas) {
      const [before, after] = await Promise.all([renderPage(baseline.bytes, 1), renderPage(removed.bytes, 1)]);
      expect(worstBlockDiff(before, after).meanError).toBeLessThan(0.01);
    }
  });

  it('deletes a photo without taking the words drawn on top of it', async () => {
    // A picture-only cover names no text. Let into text removal it would take
    // every glyph beneath the photo, so it must stay out.
    const rect = { x: 25, y: 35, w: 180, h: 140 };
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([240, 220]);
    drawRef(source, 0, rawPhoto(source, 360, 280), rect);
    const font = await source.embedFont(StandardFonts.Helvetica);
    page.drawText('HEADING ON THE PHOTO', { x: 40, y: 100, size: 12, font });
    const originalBytes = await source.save({ useObjectStreams: false });
    const exported = await exportPdf({
      originalBytes,
      pages: [geometry(0)],
      edits: [cover(0, rect)],
    });

    expect(exported.redaction).toMatchObject({ removedImages: 1, removedItems: 0 });
    expect(await textSnapshot(exported.bytes)).toEqual(await textSnapshot(originalBytes));
  });

  it('removes one page draw of a shared image while preserving the other page', async () => {
    const rect = { x: 30, y: 45, w: 120, h: 90 };
    const source = await PDFDocument.create({ updateMetadata: false });
    source.addPage([240, 220]);
    source.addPage([240, 220]);
    const ref = rawPhoto(source);
    drawRef(source, 0, ref, rect, 'Shared');
    drawRef(source, 1, ref, rect, 'Shared');
    const doc = await docFrom(source, [cover(0, rect)]);
    const [baseline, removed] = await Promise.all([
      exportPdf(doc, { removeCoveredImages: false }),
      exportPdf(doc),
    ]);

    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toEqual([]);
    expect(imageDrawsInContent(reopened, 1)).toHaveLength(1);
    expect(imageObjects(reopened)).toHaveLength(1);
    if (optionalCanvas) {
      const [before, after] = await Promise.all([renderPage(baseline.bytes, 2), renderPage(removed.bytes, 2)]);
      expect(worstBlockDiff(before, after).meanError).toBeLessThan(0.01);
    }
  });

  it('copy-on-writes a shared Form XObject before removing its image on one page', async () => {
    const rect = { x: 20, y: 30, w: 100, h: 80 };
    const inner = await PDFDocument.create({ updateMetadata: false });
    inner.addPage([240, 220]);
    drawRef(inner, 0, rawPhoto(inner), rect);
    const source = await PDFDocument.create({ updateMetadata: false });
    const [form] = await source.embedPdf(await inner.save());
    if (!form) throw new Error('Shared image form was not embedded.');
    source.addPage([240, 220]).drawPage(form);
    source.addPage([240, 220]).drawPage(form);
    const removed = await exportPdf(await docFrom(source, [cover(0, rect)]));

    expect(removed.redaction).toMatchObject({ removedImages: 1, imageSkippedPages: 0 });
    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toEqual([]);
    expect(imageDrawsInContent(reopened, 1)).toHaveLength(1);
  });

  it('deletes a transparent photo and its now-unreferenced soft mask', async () => {
    const rect = { x: 40, y: 50, w: 100, h: 80 };
    const source = await PDFDocument.create({ updateMetadata: false });
    source.addPage([240, 220]);
    drawRef(source, 0, rawPhoto(source, 80, 60, true), rect);
    const original = await PDFDocument.load((await source.save()).slice(), { updateMetadata: false });
    expect(imageObjects(original)).toHaveLength(2);

    const removed = await exportPdf(await docFrom(source, [cover(0, rect)]));
    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageObjects(reopened)).toHaveLength(0);
  });

  it('removes an inline image paint', async () => {
    const rect = { x: 20, y: 30, w: 50, h: 50 };
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([240, 220]);
    const contents = PDFRawStream.of(source.context.obj({}), new TextEncoder().encode(
      'q 50 0 0 50 20 30 cm BI /W 1 /H 1 /BPC 8 /CS /RGB /F /AHx ID FF0000> EI Q',
    ));
    page.node.set(PDFName.of('Contents'), source.context.register(contents));
    const edit: CoverEdit = {
      ...cover(0, rect),
      replacesImages: [{ kind: 'inline', rect }],
    };
    const removed = await exportPdf(await docFrom(source, [edit]));
    const reader = await getDocument({ data: removed.bytes.slice(), verbosity: 0 }).promise;
    try {
      const operators = await (await reader.getPage(1)).getOperatorList();
      expect(operators.fnArray).not.toContain(OPS.paintInlineImageXObject);
    } finally {
      await reader.destroy();
    }
  });

  it('removes an image mask paint and its stream object', async () => {
    const rect = { x: 20, y: 30, w: 60, h: 40 };
    const source = await PDFDocument.create({ updateMetadata: false });
    source.addPage([240, 220]);
    const mask = PDFRawStream.of(source.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 8, Height: 1,
      ImageMask: true, BitsPerComponent: 1,
    }), Uint8Array.of(0b10101010));
    drawRef(source, 0, source.context.register(mask), rect, 'Stencil');
    const edit: CoverEdit = {
      ...cover(0, rect),
      replacesImages: [{ kind: 'mask', rect }],
    };
    const removed = await exportPdf(await docFrom(source, [edit]));
    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageObjects(reopened)).toHaveLength(0);
  });

  it.each(['image-crop-cover', 'image-cover'])('%s leaves only the new image, never the full original', async (id) => {
    const originalRect = { x: 20, y: 30, w: 180, h: 140 };
    const newRect = id === 'image-crop-cover'
      ? { x: 20, y: 30, w: 90, h: 140 }
      : originalRect;
    const source = await PDFDocument.create({ updateMetadata: false });
    source.addPage([240, 220]);
    drawRef(source, 0, rawPhoto(source, 360, 280), originalRect);
    const edits: Edit[] = [
      cover(0, originalRect, id),
      { id: `${id}-new`, kind: 'image', pageIndex: 0, rect: newRect, z: 2, bytes: pngBytes() },
    ];
    const removed = await exportPdf(await docFrom(source, edits));
    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toHaveLength(1);
    const objects = imageObjects(reopened);
    expect(objects).toHaveLength(1);
    expect(objects.some((object) => object.width === 360 && object.height === 280)).toBe(false);
  });

  it('removes image bullet markers when an image-backed list is edited', async () => {
    const { bytes, built } = await imageBulletList(['NEW FIRST ITEM', 'NEW SECOND ITEM']);
    const sampled: PdfRect[] = [];
    const removed = await exportPdf({
      originalBytes: bytes,
      pages: [geometry(0, 260, 220)],
      edits: [...built.covers, ...built.texts],
      sampleBackground: (_pageIndex, rect) => {
        sampled.push(rect);
        return { r: 1, g: 1, b: 1 };
      },
    });
    expect(removed.redaction).toMatchObject({ removedImages: 2, imageSkippedPages: 0 });
    const reopened = await PDFDocument.load(removed.bytes, { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toEqual([]);

    // The markers were always removed. The words were not: a cover carrying
    // pictures was kept out of text removal, so the old items stayed in the
    // file under the patch, findable by search and by anything reading text.
    expect(removed.redaction.removedItems).toBeGreaterThan(0);
    expect(removed.warnings).toEqual([]);
    const exportedText = (await textSnapshot(removed.bytes))
      .map((item) => String((item as [string, number, number])[0]))
      .join(' ');
    expect(exportedText).not.toContain('OLD FIRST ITEM');
    expect(exportedText).not.toContain('OLD SECOND ITEM');
    expect(exportedText).toContain('NEW FIRST ITEM');
    expect(exportedText).toContain('NEW SECOND ITEM');
    // Words and markers are both gone, so nothing is left to hide: no patch.
    expect(sampled).toEqual([]);
  });

  it.skipIf(!optionalCanvas)('shows the real page behind an edited image-backed list, not a patch', async () => {
    const tint = { r: 0.85, g: 0.92, b: 1 };
    const { bytes, built, list } = await imageBulletList(['NEW A', 'NEW B'], tint);
    const removed = await exportPdf({
      originalBytes: bytes,
      pages: [geometry(0, 260, 220)],
      edits: [...built.covers, ...built.texts],
      // A patch would be white: a white patch on the tinted page is what this rules out.
      sampleBackground: () => ({ r: 1, g: 1, b: 1 }),
    });
    expect(removed.warnings).toEqual([]);
    // The part of the old list's area that the shorter new items leave empty must be
    // the page's own tint, with no old ink and no white rectangle.
    const cover = built.covers[0]!.rect;
    const emptyLeft = list.textX + 40;
    const empty = { x: emptyLeft, y: cover.y + 1, w: cover.x + cover.w - 1 - emptyLeft, h: cover.h - 2 };
    expect(empty.w).toBeGreaterThan(20);
    const pixels = cropImageData(await renderPage(removed.bytes, 1), empty, 220);
    const expected = [tint.r, tint.g, tint.b].map((channel) => Math.round(channel * 255));
    let off = 0;
    for (let index = 0; index < pixels.data.length; index += 4) {
      if (expected.some((channel, offset) => Math.abs((pixels.data[index + offset] ?? 0) - channel) > 2)) off += 1;
    }
    expect(off).toBe(0);
  });

  it('keeps the patch when one of the list markers cannot be found', async () => {
    const { bytes, built } = await imageBulletList(['NEW FIRST ITEM', 'NEW SECOND ITEM']);
    const [listCover, ...rest] = built.covers;
    if (!listCover?.replacesImages) throw new Error('The list cover names no marker pictures.');
    const [firstMarker, ...otherMarkers] = listCover.replacesImages;
    const misplaced: CoverEdit = {
      ...listCover,
      replacesImages: [
        { ...firstMarker!, rect: { ...firstMarker!.rect, x: firstMarker!.rect.x + 60 } },
        ...otherMarkers,
      ],
    };
    const sampled: PdfRect[] = [];
    const removed = await exportPdf({
      originalBytes: bytes,
      pages: [geometry(0, 260, 220)],
      edits: [misplaced, ...rest, ...built.texts],
      sampleBackground: (_pageIndex, rect) => {
        sampled.push(rect);
        return { r: 1, g: 1, b: 1 };
      },
    });
    expect(removed.redaction).toMatchObject({ removedImages: 1, unmatchedImages: 1 });
    expect(removed.warnings.some((warning) => warning.includes('could not be found'))).toBe(true);
    // The old words still go; the patch stays over the marker that was not removed.
    const exportedText = (await textSnapshot(removed.bytes))
      .map((item) => String((item as [string, number, number])[0]))
      .join(' ');
    expect(exportedText).not.toContain('OLD FIRST ITEM');
    expect(sampled).toHaveLength(1);
  });
});

/** Two items whose markers are 5 pt pictures, as the résumé lists draw them. */
async function imageBulletList(
  newItems: readonly string[],
  background?: { readonly r: number; readonly g: number; readonly b: number },
) {
  const source = await PDFDocument.create({ updateMetadata: false });
  const page = source.addPage([260, 220]);
  if (background) {
    page.drawRectangle({ x: 0, y: 0, width: 260, height: 220, color: rgb(background.r, background.g, background.b) });
  }
  const marker = rawPhoto(source, 4, 4);
  drawRef(source, 0, marker, { x: 28, y: 152, w: 5, h: 5 }, 'Bullet');
  drawRef(source, 0, marker, { x: 28, y: 138, w: 5, h: 5 }, 'Bullet');
  const font = await source.embedFont(StandardFonts.Helvetica);
  page.drawText('OLD FIRST ITEM', { x: 40, y: 150, size: 12, font });
  page.drawText('OLD SECOND ITEM', { x: 40, y: 136, size: 12, font });
  const bytes = await source.save({ useObjectStreams: false });
  const reader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  try {
    const sourcePage = await reader.getPage(1);
    const operatorList = await sourcePage.getOperatorList();
    const regions = imageRegionsFromOperatorList(operatorList, sourcePage.getViewport({ scale: 1 }), 0);
    const blocks = groupRunsIntoBlocks(await extractTextRuns(sourcePage, 0));
    const lines = blocks.flatMap((block) => block.lines);
    const left = Math.min(...lines.map((line) => line.rect.x));
    const bottom = Math.min(...lines.map((line) => line.rect.y));
    const right = Math.max(...lines.map((line) => line.rect.x + line.rect.w));
    const top = Math.max(...lines.map((line) => line.rect.y + line.rect.h));
    const firstBlock = blocks[0];
    if (!firstBlock) throw new Error('Image bullet fixture has no text block.');
    const block = {
      ...firstBlock,
      text: lines.map((line) => line.text).join('\n'),
      rect: { x: left, y: bottom, w: right - left, h: top - bottom },
      lines,
    };
    const list = detectBulletListFromRegions(block, regions);
    expect(list).not.toBeNull();
    if (!list) throw new Error('Image bullet fixture was not detected.');
    const items = newItems.map((text) => ({ text, lines: [text] }));
    const built = buildBulletListEdits(list, {
      text: formatBulletEditorText(newItems),
      style: list.block.style,
      width: list.coverRect.w,
      height: list.coverRect.h,
      dx: 0,
      dy: 0,
    }, items, 1, 100);
    return { bytes, built, list };
  } finally {
    await reader.destroy();
  }
}
