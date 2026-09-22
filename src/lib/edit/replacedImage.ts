import type { ReplacedImage } from '@/lib/export/types';
import type { DrawnImage, ImageRegion } from '@/lib/pdf/images';

function sameRect(left: ImageRegion['rect'], right: ImageRegion['rect']): boolean {
  return ['x', 'y', 'w', 'h'].every((key) => (
    Math.abs(left[key as keyof ImageRegion['rect']] - right[key as keyof ImageRegion['rect']]) <= 0.01
  ));
}

/** Record the stable file-space identity of the image the editor offered to the user. */
export function replacedImageFor(
  region: ImageRegion,
  draws: readonly DrawnImage[],
): ReplacedImage {
  const draw = draws.find((candidate) => (
    candidate.visibleRect && sameRect(candidate.visibleRect, region.rect)
  ));
  return {
    kind: draw?.kind ?? 'image',
    rect: { ...(draw?.visibleRect ?? region.rect) },
  };
}
