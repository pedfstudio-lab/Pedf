import { describe, expect, it } from 'vitest';
import { acceptAttribute, HEIC_GUIDANCE, validateFiles } from './files';

describe('tool input validation', () => {
  const pdf = new File(['pdf'], 'file.PDF');
  const image = new File(['png'], 'photo.png', { type: 'image/png' });
  it('respects PDF, image and mixed-file acceptance', () => {
    expect(validateFiles([pdf], { accepts: 'pdf', multiple: true })).toBeUndefined();
    expect(validateFiles([image], { accepts: 'pdf', multiple: true })).toBe('Choose a PDF file.');
    expect(validateFiles([pdf], { accepts: 'image', multiple: true })).toBe('Choose JPG, PNG, or WebP images.');
    expect(validateFiles([pdf, image], { accepts: 'pdf-or-image', multiple: true })).toBeUndefined();
    expect(acceptAttribute('image')).not.toContain('application/pdf');
    expect(acceptAttribute('image')).toContain('.heic');
  });
  it('rejects multiple files for a single-file tool rather than silently discarding them', () => {
    expect(validateFiles([pdf, pdf], { accepts: 'pdf', multiple: false })).toBe('Choose one file at a time.');
  });

  it('gives HEIC users conversion guidance', () => {
    const heic = new File(['heic'], 'phone-photo.HEIC', { type: 'image/heic' });
    expect(validateFiles([heic], { accepts: 'image', multiple: true })).toBe(HEIC_GUIDANCE);
  });
});
