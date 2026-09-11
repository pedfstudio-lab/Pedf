import {
  degrees,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  rgb,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { WatermarkOptions } from '@/components/tools/WatermarkOptions';
import { readerAngleToRaw, readerFrame, readerToRaw } from '@/lib/pdf/readerFrame';
import { ToolError } from './errors';
import { loadPdfLib, outputName, savePdf } from './pdfIo';
import { selectedPageIndices } from './pdfToJpgOptions';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';
import { autoFontSize, watermarkPlacements, type WatermarkPlacement } from './watermarkLayout';
import {
  DEFAULT_WATERMARK_OPTIONS,
  parseWatermarkOptions,
  WATERMARK_COLOURS,
  WATERMARK_FONTS,
  watermarkProblem,
  type WatermarkOptionsValue,
} from './watermarkOptions';

export const WATERMARK_INPUT_ERROR = 'Choose one PDF file to watermark.';

export type WatermarkAssets =
  | { kind: 'text'; font: PDFFont }
  | { kind: 'image'; image: PDFImage };

export async function prepareWatermarkAssets(doc: PDFDocument, options: ToolOptions): Promise<WatermarkAssets> {
  const value = parseWatermarkOptions(options);
  if (value.mode === 'image') {
    if (!value.imageBytes || !value.imageMime) throw new ToolError('Choose an image for the watermark first.');
    const image = value.imageMime === 'image/jpeg'
      ? await doc.embedJpg(value.imageBytes)
      : await doc.embedPng(value.imageBytes);
    return { kind: 'image', image };
  }
  const family = WATERMARK_FONTS[value.font];
  return { kind: 'text', font: await doc.embedFont(value.bold ? family.bold : family.regular) };
}

function markedWatermarkStart(): PDFOperator {
  return PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
    PDFName.of('Artifact'),
    '<< /Type /Pagination /Subtype /Watermark >>',
  ]);
}

/** Where the watermark went, in reader points — the preview uses it to place the drag handle. */
export interface WatermarkGeometry {
  pageWidth: number;
  pageHeight: number;
  itemWidth: number;
  itemHeight: number;
  fontSize: number;
  /** Reader-space angle in degrees (counter-clockwise, as the reader sees it). */
  angle: number;
  placements: WatermarkPlacement[];
}

/** Draw one watermark layer over a page without changing any of the source page content. */
export function watermarkPage(page: PDFPage, options: ToolOptions, assets: WatermarkAssets): WatermarkGeometry {
  const value = parseWatermarkOptions(options);
  const frame = readerFrame(page);
  let itemWidth: number;
  let itemHeight: number;
  let fontSize = 0;

  if (assets.kind === 'text') {
    const widthAt1pt = assets.font.widthOfTextAtSize(value.text, 1);
    fontSize = value.size === 'auto'
      ? autoFontSize(widthAt1pt, frame.width, frame.height, value.angle)
      : value.size;
    itemWidth = assets.font.widthOfTextAtSize(value.text, fontSize);
    itemHeight = assets.font.heightAtSize(fontSize, { descender: false });
  } else {
    itemWidth = frame.width * value.imageScale;
    itemHeight = itemWidth * assets.image.height / assets.image.width;
  }

  const placements = watermarkPlacements({
    pageWidth: frame.width,
    pageHeight: frame.height,
    itemWidth,
    itemHeight,
    angle: value.angle,
    position: value.position,
    margin: Math.min(frame.width, frame.height) * 0.05,
    custom: { x: value.customX, y: value.customY },
  });
  const rotation = degrees(readerAngleToRaw(frame, value.angle));

  page.pushOperators(markedWatermarkStart());
  for (const placement of placements) {
    const raw = readerToRaw(frame, placement.u, placement.v);
    if (assets.kind === 'text') {
      const colour = WATERMARK_COLOURS[value.colour];
      page.drawText(value.text, {
        x: raw.x,
        y: raw.y,
        font: assets.font,
        size: fontSize,
        color: rgb(...colour),
        opacity: value.opacity,
        rotate: rotation,
      });
    } else {
      page.drawImage(assets.image, {
        x: raw.x,
        y: raw.y,
        width: itemWidth,
        height: itemHeight,
        opacity: value.opacity,
        rotate: rotation,
      });
    }
  }
  page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  return {
    pageWidth: frame.width,
    pageHeight: frame.height,
    itemWidth,
    itemHeight,
    fontSize,
    angle: value.angle,
    placements,
  };
}

export async function run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  const { signal, onProgress } = ctx;
  signal.throwIfAborted();
  if (inputs.length !== 1) throw new ToolError(WATERMARK_INPUT_ERROR);
  const problem = watermarkProblem(options);
  if (problem) throw new ToolError(problem);
  const file = inputs[0]!;
  const value: WatermarkOptionsValue = parseWatermarkOptions(options);
  const doc = await loadPdfLib(file);
  signal.throwIfAborted();
  const selected = selectedPageIndices(value, doc.getPageCount());
  const assets = await prepareWatermarkAssets(doc, value);

  for (const [index, pageIndex] of selected.entries()) {
    signal.throwIfAborted();
    onProgress(index, selected.length, `Watermarking page ${index + 1} of ${selected.length}`);
    watermarkPage(doc.getPage(pageIndex), value, assets);
    if ((index + 1) % 20 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  signal.throwIfAborted();
  const bytes = await savePdf(doc);
  signal.throwIfAborted();
  onProgress(selected.length, selected.length, 'Watermarked PDF ready');
  return [{ name: outputName(file, 'watermarked'), bytes, mime: 'application/pdf' }];
}

export const watermarkTool: ToolDefinition = {
  slug: 'watermark',
  title: 'Watermark PDF',
  description: 'Stamp text or a logo across your pages — see it before you save.',
  accepts: 'pdf',
  multiple: false,
  defaultOptions: DEFAULT_WATERMARK_OPTIONS,
  canRun: (options) => watermarkProblem(options),
  Options: WatermarkOptions,
  icon: '◈',
  run,
};
