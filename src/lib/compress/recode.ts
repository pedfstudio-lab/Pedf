export interface DecodedImagePixels {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly originalBytes: number;
}

export const MIN_PHOTO_SAVING = 8 * 1024;

export interface RecodeTarget { readonly width: number; readonly height: number }
export type JpegEncoder = (
  pixels: DecodedImagePixels,
  target: RecodeTarget,
  quality: number,
) => Promise<Uint8Array>;

/** Flatten alpha and keep JPEG only when it saves at least 15% and at least 8 KB. */
export async function recodeImage(
  pixels: DecodedImagePixels,
  target: RecodeTarget,
  quality: number,
  encode: JpegEncoder,
): Promise<Uint8Array | undefined> {
  const opaque = new Uint8ClampedArray(pixels.data);
  for (let offset = 3; offset < opaque.length; offset += 4) opaque[offset] = 255;
  const encoded = await encode({ ...pixels, data: opaque }, target, quality);
  const saving = pixels.originalBytes - encoded.byteLength;
  return encoded.byteLength <= pixels.originalBytes * 0.85 && saving >= MIN_PHOTO_SAVING
    ? encoded
    : undefined;
}

/** Resize a soft mask with bilinear sampling and pack the resulting DeviceGray samples. */
export function resizeSoftMask(
  pixels: DecodedImagePixels,
  target: RecodeTarget,
): Uint8Array {
  const output = new Uint8Array(target.width * target.height);
  const sourceValue = (x: number, y: number) => pixels.data[(y * pixels.width + x) * 4] ?? 255;
  for (let y = 0; y < target.height; y++) {
    const sourceY = Math.max(0, Math.min(pixels.height - 1,
      (y + 0.5) * pixels.height / target.height - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.max(0, Math.min(pixels.height - 1, y0 + 1));
    const yWeight = sourceY - y0;
    for (let x = 0; x < target.width; x++) {
      const sourceX = Math.max(0, Math.min(pixels.width - 1,
        (x + 0.5) * pixels.width / target.width - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.max(0, Math.min(pixels.width - 1, x0 + 1));
      const xWeight = sourceX - x0;
      const top = sourceValue(x0, y0) * (1 - xWeight) + sourceValue(x1, y0) * xWeight;
      const bottom = sourceValue(x0, y1) * (1 - xWeight) + sourceValue(x1, y1) * xWeight;
      const value = Math.round(top * (1 - yWeight) + bottom * yWeight);
      output[y * target.width + x] = value;
    }
  }
  return output;
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('The photo could not be encoded.')),
    'image/jpeg', quality,
  ));
}

/** Browser JPEG encoder used by the real compressor; tests inject a deterministic fake. */
export async function encodeJpeg(
  pixels: DecodedImagePixels,
  target: RecodeTarget,
  quality: number,
): Promise<Uint8Array> {
  const source = document.createElement('canvas');
  const output = document.createElement('canvas');
  source.width = pixels.width;
  source.height = pixels.height;
  output.width = target.width;
  output.height = target.height;
  try {
    const sourceContext = source.getContext('2d');
    const outputContext = output.getContext('2d');
    if (!sourceContext || !outputContext) throw new Error('Canvas is unavailable.');
    const sourceImage = new ImageData(pixels.width, pixels.height);
    sourceImage.data.set(pixels.data);
    sourceContext.putImageData(sourceImage, 0, 0);
    outputContext.fillStyle = '#fff';
    outputContext.fillRect(0, 0, target.width, target.height);
    outputContext.imageSmoothingEnabled = true;
    outputContext.imageSmoothingQuality = 'high';
    outputContext.drawImage(source, 0, 0, target.width, target.height);
    const blob = await canvasBlob(output, quality);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    source.width = source.height = 0;
    output.width = output.height = 0;
  }
}
