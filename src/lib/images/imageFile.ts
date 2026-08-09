import type { PdfRect } from '@/lib/export/types';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function isPng(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG_SIGNATURE);
}

export function isJpg(bytes: Uint8Array): boolean {
  return startsWith(bytes, JPEG_SIGNATURE);
}

export function imageMimeType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  if (isPng(bytes)) return 'image/png';
  if (isJpg(bytes)) return 'image/jpeg';
  return undefined;
}

/** Largest centered rectangle with the source aspect ratio that fits inside `target`. */
export function fitImageRect(
  target: PdfRect,
  pixelWidth: number,
  pixelHeight: number,
): PdfRect {
  if (
    !Number.isFinite(pixelWidth) || pixelWidth <= 0 ||
    !Number.isFinite(pixelHeight) || pixelHeight <= 0 ||
    !Number.isFinite(target.w) || target.w <= 0 ||
    !Number.isFinite(target.h) || target.h <= 0
  ) {
    throw new RangeError('Image and target dimensions must be positive finite numbers.');
  }
  const imageRatio = pixelWidth / pixelHeight;
  const targetRatio = target.w / target.h;
  const width = imageRatio >= targetRatio ? target.w : target.h * imageRatio;
  const height = imageRatio >= targetRatio ? target.w / imageRatio : target.h;
  return {
    x: target.x + (target.w - width) / 2,
    y: target.y + (target.h - height) / 2,
    w: width,
    h: height,
  };
}
