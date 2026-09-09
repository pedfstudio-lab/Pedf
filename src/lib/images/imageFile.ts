import type { PdfRect } from '@/lib/export/types';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function isPng(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG_SIGNATURE);
}

export function isJpg(bytes: Uint8Array): boolean {
  return startsWith(bytes, JPEG_SIGNATURE);
}

export function isWebp(bytes: Uint8Array): boolean {
  return startsWith(bytes, RIFF_SIGNATURE)
    && WEBP_SIGNATURE.every((value, index) => bytes[index + 8] === value);
}

export function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') return false;
  const boxLength = Math.min(bytes.length, Math.max(12, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)));
  for (let offset = 8; offset + 4 <= boxLength; offset += 4) {
    const brand = String.fromCharCode(...bytes.slice(offset, offset + 4)).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return true;
  }
  return false;
}

export function imageMimeType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (isPng(bytes)) return 'image/png';
  if (isJpg(bytes)) return 'image/jpeg';
  if (isWebp(bytes)) return 'image/webp';
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

/** Smallest centered rectangle with the source aspect ratio that fully covers `target`. */
export function coverImageRect(
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
  const width = imageRatio >= targetRatio ? target.h * imageRatio : target.w;
  const height = imageRatio >= targetRatio ? target.h : target.w / imageRatio;
  return {
    x: target.x + (target.w - width) / 2,
    y: target.y + (target.h - height) / 2,
    w: width,
    h: height,
  };
}
