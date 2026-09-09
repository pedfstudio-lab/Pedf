// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JPG_TO_PDF_OPTIONS } from '@/lib/tools/jpgToPdfOptions';
import { JpgToPdfOptions } from './JpgToPdfOptions';

afterEach(cleanup);

describe('JpgToPdfOptions', () => {
  it('starts with fit, auto, no margin and one image per page', () => {
    render(<JpgToPdfOptions options={DEFAULT_JPG_TO_PDF_OPTIONS} onChange={vi.fn()} inputs={[]} disabled={false} />);
    expect((screen.getByLabelText('Page size') as HTMLSelectElement).value).toBe('fit');
    expect((screen.getByLabelText('Orientation') as HTMLSelectElement).value).toBe('auto');
    expect((screen.getByLabelText('Margin') as HTMLSelectElement).value).toBe('none');
    expect((screen.getByLabelText('Images per page') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText('Images per page') as HTMLSelectElement).disabled).toBe(false);
    expect([...(screen.getByLabelText('Images per page') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['1', '2', '4']);
  });

  it('switches to 2 or 4 images per page as a number', () => {
    const onChange = vi.fn();
    render(<JpgToPdfOptions options={DEFAULT_JPG_TO_PDF_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.change(screen.getByLabelText('Images per page'), { target: { value: '4' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_JPG_TO_PDF_OPTIONS, imagesPerPage: 4 });
  });

  it('updates each configurable layout option', () => {
    const onChange = vi.fn();
    const { rerender } = render(<JpgToPdfOptions options={DEFAULT_JPG_TO_PDF_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.change(screen.getByLabelText('Page size'), { target: { value: 'a4' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_JPG_TO_PDF_OPTIONS, pageSize: 'a4' });
    rerender(<JpgToPdfOptions options={{ ...DEFAULT_JPG_TO_PDF_OPTIONS, pageSize: 'a4' }} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.change(screen.getByLabelText('Orientation'), { target: { value: 'landscape' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_JPG_TO_PDF_OPTIONS, pageSize: 'a4', orientation: 'landscape' });
    fireEvent.change(screen.getByLabelText('Margin'), { target: { value: 'big' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_JPG_TO_PDF_OPTIONS, pageSize: 'a4', margin: 'big' });
  });

  it('disables the fieldset while processing', () => {
    render(<JpgToPdfOptions options={DEFAULT_JPG_TO_PDF_OPTIONS} onChange={vi.fn()} inputs={[]} disabled />);
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
  });
});
