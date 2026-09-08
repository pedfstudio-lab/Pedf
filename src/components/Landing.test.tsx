// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '@/lib/site/navigate';
import * as pendingFile from '@/lib/site/pendingFile';
import { Landing } from './Landing';

vi.mock('@/lib/site/navigate', () => ({ navigate: vi.fn() }));

describe('Landing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    pendingFile.takePendingFile();
    vi.restoreAllMocks();
  });

  it('renders the core PEDF Studio experience', () => {
    const { container } = render(<Landing />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Read it. Ask it. Edit it.');
    expect(screen.getByRole('link', { name: 'Try it free' }).getAttribute('href')).toBe('/app');
    expect(screen.getByText('English, Hindi & 8 more Indian languages')).toBeTruthy();
    expect(screen.getByText('© 2026 PEDF Studio')).toBeTruthy();
    expect(container.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('application/pdf');
  });

  it('keeps a chosen PDF in memory and navigates to the editor', () => {
    const setPendingFile = vi.spyOn(pendingFile, 'setPendingFile');
    const { container } = render(<Landing />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['%PDF-1.7'], 'chosen-test.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [file] } });

    expect(setPendingFile).toHaveBeenCalledWith(file);
    expect(navigate).toHaveBeenCalledWith('/app');
    expect(pendingFile.takePendingFile()).toBe(file);
  });

  it('hands a dropped PDF to the same in-page navigation flow', () => {
    const file = new File(['%PDF-1.7'], 'dropped-test.pdf', { type: 'application/pdf' });
    render(<Landing />);

    fireEvent.drop(screen.getByRole('button', { name: /drag & drop your PDF here/i }), {
      dataTransfer: { files: [file] },
    });

    expect(navigate).toHaveBeenCalledWith('/app');
    expect(pendingFile.takePendingFile()).toBe(file);
  });

  it('rejects a non-PDF without navigating or carrying a file', () => {
    const { container } = render(<Landing />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    fireEvent.change(input, {
      target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })] },
    });

    expect(screen.getByRole('alert').textContent).toBe('Choose a PDF file to continue.');
    expect(navigate).not.toHaveBeenCalled();
    expect(pendingFile.takePendingFile()).toBeUndefined();
  });
});
