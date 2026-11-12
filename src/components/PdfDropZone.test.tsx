// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfDropZone } from './PdfDropZone';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PdfDropZone', () => {
  it('says "choose", never "upload", and that the PDF stays on the computer', () => {
    render(<PdfDropZone onFile={vi.fn()} />);
    expect(screen.getByText('or click to choose it. It stays on your computer.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/upload/i);
  });

  it('asks phone users to tap, since they cannot drag', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(pointer: coarse)', media: query })));
    render(<PdfDropZone onFile={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Tap to choose your PDF/ })).toBeTruthy();
    expect(screen.getByText('It stays on your device.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/drag|click/i);
  });

  it('keeps the drag-and-click words on a touchscreen laptop that also has a trackpad', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(pointer: coarse)' || query === '(any-pointer: fine)',
      media: query,
    })));
    render(<PdfDropZone onFile={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Drag & drop your PDF here/ })).toBeTruthy();
  });

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

  describe('wide (home page first screen)', () => {
    it('is one big button named "Drop your PDF here", with a "Choose your PDF" look inside', () => {
      const onFile = vi.fn();
      render(<PdfDropZone onFile={onFile} variant="wide" />);
      const area = screen.getByRole('button', { name: 'Drop your PDF here' });
      expect(area.classList.contains('drop-zone--wide')).toBe(true);
      expect(area.textContent).toContain('Choose your PDF');
      expect(screen.getByText('It stays on your device.')).toBeTruthy();
      expect(document.querySelectorAll('button')).toHaveLength(1);
      const file = new File(['%PDF-1.7'], 'wide.pdf', { type: 'application/pdf' });
      fireEvent.drop(area, { dataTransfer: { files: [file] } });
      expect(onFile).toHaveBeenCalledWith(file);
    });

    it('asks phone and tablet users to tap, without "drop" or "or"', () => {
      vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(pointer: coarse)', media: query })));
      render(<PdfDropZone onFile={vi.fn()} variant="wide" />);
      const area = screen.getByRole('button', { name: 'Tap to choose your PDF' });
      expect(area.classList.contains('drop-zone--touch')).toBe(true);
      expect(area.querySelector('.drop-zone__choose')?.textContent).toBe('Tap to choose your PDF');
    });

    it("keeps the editor's own upload box unchanged", () => {
      render(<PdfDropZone onFile={vi.fn()} />);
      expect(screen.getByRole('button', { name: /Drag & drop your PDF here/ }).classList.contains('drop-zone--wide')).toBe(false);
      expect(document.querySelector('.drop-zone__choose')).toBeNull();
    });
  });

});
