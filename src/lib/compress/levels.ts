export type CompressLevel = 'light' | 'medium' | 'strong' | 'smallest';

export interface CompressLevelDefinition {
  readonly id: CompressLevel;
  readonly label: string;
  readonly dpi: number;
  readonly quality: number;
  readonly description: string;
}

export const LEVELS: Readonly<Record<CompressLevel, CompressLevelDefinition>> = {
  light: { id: 'light', label: 'Light', dpi: 200, quality: 0.85, description: 'Best quality · good for printing' },
  medium: { id: 'medium', label: 'Medium', dpi: 150, quality: 0.75, description: 'Good for email and screens' },
  strong: { id: 'strong', label: 'Strong', dpi: 110, quality: 0.6, description: 'Smallest · photos a little soft up close' },
  smallest: { id: 'smallest', label: 'Smallest', dpi: 80, quality: 0.5, description: 'For strict upload limits · photos get soft' },
};

export const LEVEL_LADDER: readonly CompressLevel[] = ['light', 'medium', 'strong', 'smallest'];

export interface ImageSizing {
  readonly width: number;
  readonly height: number;
  readonly drawnWidthPt: number;
  readonly drawnHeightPt: number;
}

/**
 * In most PDFs the weight is the photos, not the text. Work out how many pixels the
 * drawn size needs at this level's dpi, while keeping the aspect ratio and never enlarging.
 */
export function targetSize(image: ImageSizing, dpi: number): { width: number; height: number; scale: number } {
  const width = Math.max(1, Math.round(image.width));
  const height = Math.max(1, Math.round(image.height));
  const safeDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 1;
  const drawnWidthInches = Math.max(0, image.drawnWidthPt) / 72;
  const drawnHeightInches = Math.max(0, image.drawnHeightPt) / 72;
  const detailScale = Math.max(drawnWidthInches * safeDpi / width, drawnHeightInches * safeDpi / height);
  const minimumScale = Math.max(Math.min(1, 16 / width), Math.min(1, 16 / height));
  const scale = Math.min(1, Math.max(0, detailScale, minimumScale));
  return {
    width: Math.min(width, Math.max(1, Math.round(width * scale))),
    height: Math.min(height, Math.max(1, Math.round(height * scale))),
    scale,
  };
}
