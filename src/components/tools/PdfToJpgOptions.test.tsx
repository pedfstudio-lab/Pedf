// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PDF_TO_JPG_OPTIONS } from '@/lib/tools/pdfToJpgOptions';
import { PdfToJpgOptions } from './PdfToJpgOptions';

const { loadPdfJs } = vi.hoisted(() => ({ loadPdfJs: vi.fn() }));
vi.mock('@/lib/tools/pdfIo', () => ({ loadPdfJs }));

beforeEach(() => {
  loadPdfJs.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function loadedSize(width = 595, height = 842) {
  const cleanupPage = vi.fn();
  const destroy = vi.fn(async () => {});
  loadPdfJs.mockResolvedValue({
    doc: {
      getPage: vi.fn(async () => ({ getViewport: () => ({ width, height }), cleanup: cleanupPage })),
      destroy,
    },
  });
  return { cleanupPage, destroy };
}

describe('PdfToJpgOptions', () => {
  it('defaults to JPG, Normal quality and all pages', () => {
    render(<PdfToJpgOptions options={DEFAULT_PDF_TO_JPG_OPTIONS} onChange={vi.fn()} inputs={[]} disabled={false} />);
    expect((screen.getByLabelText('Format') as HTMLSelectElement).value).toBe('jpg');
    expect((screen.getByLabelText('Quality') as HTMLSelectElement).value).toBe('normal');
    expect((screen.getByLabelText('Pages') as HTMLSelectElement).value).toBe('all');
    expect(screen.queryByLabelText('Pages or ranges')).toBeNull();
  });

  it('updates format and quality', () => {
    const onChange = vi.fn();
    render(<PdfToJpgOptions options={DEFAULT_PDF_TO_JPG_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'png' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PDF_TO_JPG_OPTIONS, format: 'png' });
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'high' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PDF_TO_JPG_OPTIONS, quality: 'high' });
  });

  it('shows and updates ranges only for Only these pages', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PdfToJpgOptions options={DEFAULT_PDF_TO_JPG_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.change(screen.getByLabelText('Pages'), { target: { value: 'custom' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_PDF_TO_JPG_OPTIONS, pageSelection: 'custom' });
    const custom = { ...DEFAULT_PDF_TO_JPG_OPTIONS, pageSelection: 'custom' as const };
    rerender(<PdfToJpgOptions options={custom} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.change(screen.getByLabelText('Pages or ranges'), { target: { value: '1-3, 5' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...custom, ranges: '1-3, 5' });
  });

  it('shows the real page 1 pixel size and updates it with quality', async () => {
    const { cleanupPage, destroy } = loadedSize();
    const file = new File(['%PDF'], 'fixture.pdf', { type: 'application/pdf' });
    const { rerender } = render(<PdfToJpgOptions options={DEFAULT_PDF_TO_JPG_OPTIONS} onChange={vi.fn()} inputs={[file]} disabled={false} />);
    expect(await screen.findByText('Page 1 will be 1240 × 1755 px at 150 dpi.')).toBeTruthy();
    expect(cleanupPage).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    rerender(<PdfToJpgOptions options={{ ...DEFAULT_PDF_TO_JPG_OPTIONS, quality: 'high' }} onChange={vi.fn()} inputs={[file]} disabled={false} />);
    expect(screen.getByText('Page 1 will be 2480 × 3509 px at 300 dpi.')).toBeTruthy();
    expect(loadPdfJs).toHaveBeenCalledOnce();
  });

  it('disables all configurable controls while processing', () => {
    render(<PdfToJpgOptions options={DEFAULT_PDF_TO_JPG_OPTIONS} onChange={vi.fn()} inputs={[]} disabled />);
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
  });
});
