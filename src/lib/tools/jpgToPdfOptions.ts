export type ImagePageSize = 'fit' | 'a4' | 'letter';
export type ImagePageOrientation = 'auto' | 'portrait' | 'landscape';
export type ImagePageMargin = 'none' | 'small' | 'big';
export type ImagesPerPage = 1 | 2 | 4;

export const IMAGES_PER_PAGE_CHOICES: readonly ImagesPerPage[] = [1, 2, 4];

export interface JpgToPdfOptionsValue {
  [key: string]: unknown;
  pageSize: ImagePageSize;
  orientation: ImagePageOrientation;
  margin: ImagePageMargin;
  imagesPerPage: ImagesPerPage;
}

export const DEFAULT_JPG_TO_PDF_OPTIONS: JpgToPdfOptionsValue = {
  pageSize: 'fit',
  orientation: 'auto',
  margin: 'none',
  imagesPerPage: 1,
};

export function imagesPerPageOf(value: unknown): ImagesPerPage {
  return value === 2 || value === 4 ? value : 1;
}
