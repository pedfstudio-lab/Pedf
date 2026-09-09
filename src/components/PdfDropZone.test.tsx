// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfDropZone } from './PdfDropZone';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PdfDropZone', () => {
  it('opens its hidden PDF input when the box is clicked', () => {
    render(<PdfDropZone onFile={vi.fn()} />);
    const input = screen.getByLabelText<HTMLInputElement>('Drag & drop your PDF here');
    const click = vi.spyOn(input, 'click');

    fireEvent.click(screen.getByRole('button', { name: /drag & drop your PDF here/i }));

    expect(input.hidden).toBe(true);
    expect(input.accept).toBe('application/pdf');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('passes the chosen PDF to onFile', () => {
    const onFile = vi.fn();
    render(<PdfDropZone onFile={onFile} />);
    const file = new File(['%PDF-1.7'], 'chosen.pdf', { type: 'application/pdf' });

    fireEvent.change(screen.getByLabelText('Drag & drop your PDF here'), {
      target: { files: [file] },
    });

    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('reports a non-PDF to onError without opening it', () => {
    const onFile = vi.fn();
    const onError = vi.fn();
    render(<PdfDropZone onFile={onFile} onError={onError} />);

    fireEvent.change(screen.getByLabelText('Drag & drop your PDF here'), {
      target: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] },
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Choose a PDF file.');
    expect(onFile).not.toHaveBeenCalled();
  });

  it('accepts a dropped PDF without a MIME type and clears the drag highlight', () => {
    const onFile = vi.fn();
    render(<PdfDropZone onFile={onFile} />);
    const box = screen.getByRole('button', { name: /drag & drop your PDF here/i });
    const file = new File(['%PDF-1.7'], 'dropped.PDF');

    fireEvent.dragEnter(box);
    expect(box.classList.contains('drop-zone--active')).toBe(true);
    fireEvent.drop(box, { dataTransfer: { files: [file] } });

    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(file);
    expect(box.classList.contains('drop-zone--active')).toBe(false);
  });

  it('shows an inline error without onError and clears it after a valid drop', () => {
    const onFile = vi.fn();
    render(<PdfDropZone onFile={onFile} />);
    const box = screen.getByRole('button', { name: /drag & drop your PDF here/i });
    fireEvent.drop(box, { dataTransfer: { files: [new File(['text'], 'notes.txt')] } });
    expect(screen.getByRole('alert').textContent).toBe('Choose a PDF file.');
    expect(onFile).not.toHaveBeenCalled();

    const file = new File(['%PDF-1.7'], 'retry.pdf');
    fireEvent.drop(box, { dataTransfer: { files: [file] } });

    expect(screen.getByRole('alert').textContent).toBe('');
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(file);
  });
});
