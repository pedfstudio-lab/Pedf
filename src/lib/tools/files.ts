import { isPdf } from '@/lib/site/pdfFile';
import type { ToolDefinition } from './types';

export function isImage(file: File): boolean {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
    || /\.(jpe?g|png|webp)$/i.test(file.name);
}

export function acceptAttribute(accepts: ToolDefinition['accepts']): string {
  const images = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
  return accepts === 'pdf' ? 'application/pdf,.pdf'
    : accepts === 'image' ? images : `application/pdf,.pdf,${images}`;
}

export function validateFiles(files: File[], tool: Pick<ToolDefinition, 'accepts' | 'multiple'>): string | undefined {
  if (!tool.multiple && files.length > 1) return 'Choose one file at a time.';
  const valid = files.every((file) => tool.accepts === 'pdf' ? isPdf(file)
    : tool.accepts === 'image' ? isImage(file) : isPdf(file) || isImage(file));
  if (valid) return;
  return tool.accepts === 'pdf' ? 'Choose a PDF file.'
    : tool.accepts === 'image' ? 'Choose JPG, PNG, or WebP images.' : 'Choose PDF, JPG, PNG, or WebP files.';
}
