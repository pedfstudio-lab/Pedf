import { parsePageRanges } from './pageRanges';
import type { ToolOptions } from './types';

export type PdfImageFormat = 'jpg' | 'png';
export type PdfImageQuality = 'normal' | 'high' | 'small';
export type PdfPageSelection = 'all' | 'custom';

export const QUALITY_DPI: Record<PdfImageQuality, number> = {
  normal: 150,
  high: 300,
  small: 72,
};

export interface PdfToJpgOptionsValue {
  [key: string]: unknown;
  format: PdfImageFormat;
  quality: PdfImageQuality;
  pageSelection: PdfPageSelection;
  ranges: string;
}

export const DEFAULT_PDF_TO_JPG_OPTIONS: PdfToJpgOptionsValue = {
  format: 'jpg',
  quality: 'normal',
  pageSelection: 'all',
  ranges: '',
};

export function parsePdfToJpgOptions(options: ToolOptions): PdfToJpgOptionsValue {
  return {
    format: options.format === 'png' ? 'png' : 'jpg',
    quality: options.quality === 'high' || options.quality === 'small' ? options.quality : 'normal',
    pageSelection: options.pageSelection === 'custom' ? 'custom' : 'all',
    ranges: typeof options.ranges === 'string' ? options.ranges : '',
  };
}

export function dpiForQuality(quality: unknown): number {
  return QUALITY_DPI[quality === 'high' || quality === 'small' ? quality : 'normal'];
}

export function pagePixelSize(widthAt72Dpi: number, heightAt72Dpi: number, dpi: number) {
  const scale = dpi / 72;
  return { width: Math.ceil(widthAt72Dpi * scale), height: Math.ceil(heightAt72Dpi * scale) };
}

export function selectedPageIndices(options: ToolOptions, pageCount: number): number[] {
  const value = parsePdfToJpgOptions(options);
  if (value.pageSelection === 'all') return Array.from({ length: pageCount }, (_, index) => index);
  return [...new Set(parsePageRanges(value.ranges, pageCount).flat())].sort((a, b) => a - b);
}
