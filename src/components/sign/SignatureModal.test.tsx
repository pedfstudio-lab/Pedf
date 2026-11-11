// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignatureModal, signaturePageLabel } from './SignatureModal';

vi.mock('./SignatureMaker', () => ({
  SignatureMaker: ({ onCancel, onDone }: { onCancel(): void; onDone(value: unknown): void }) => <div>
    <button type="button" onClick={onCancel}>Cancel maker</button>
    <button type="button" onClick={() => onDone({ png: new Uint8Array([1]), width: 1, height: 1 })}>Use maker</button>
  </div>,
}));

afterEach(cleanup);

describe('SignatureModal', () => {
  it('closes on Escape, traps Tab, and forwards the signature', () => {
    const close = vi.fn();
    const done = vi.fn();
    render(<SignatureModal open pageCount={1} currentPage={0} onClose={close} onDone={done} />);
    expect(screen.getByRole('dialog', { name: 'Add a signature' })).toBeTruthy();
    const first = screen.getByRole('button', { name: 'Close signature maker' });
    const last = screen.getByRole('button', { name: 'Use maker' });
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.click(last);
    expect(done).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('lets the user choose the page, starting on the page in view', () => {
    const done = vi.fn();
    render(<SignatureModal open pageCount={6} currentPage={1} onClose={vi.fn()} onDone={done} />);
    const choice = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Add to' });
    expect(choice.value).toBe('1');
    expect([...choice.options].map((option) => option.text)).toEqual([
      'Page 1', 'Page 2 (this page)', 'Page 3', 'Page 4', 'Page 5', 'Page 6 (last page)',
    ]);
    fireEvent.change(choice, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use maker' }));
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ width: 1 }), 5);
  });

  it('starts fresh on the page in view every time it opens', () => {
    const { rerender } = render(<SignatureModal open pageCount={3} currentPage={0} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Add to' }), { target: { value: '2' } });
    rerender(<SignatureModal open={false} pageCount={3} currentPage={1} onClose={vi.fn()} onDone={vi.fn()} />);
    rerender(<SignatureModal open pageCount={3} currentPage={1} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Add to' }).value).toBe('1');
  });

  it('shows no page choice for a one-page PDF and signs page 1', () => {
    const done = vi.fn();
    render(<SignatureModal open pageCount={1} currentPage={0} onClose={vi.fn()} onDone={done} />);
    expect(screen.queryByRole('combobox', { name: 'Add to' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use maker' }));
    expect(done).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('names a page that is both in view and the last one', () => {
    expect(signaturePageLabel(2, 3, 2)).toBe('Page 3 (this page, last page)');
    expect(signaturePageLabel(0, 3, 2)).toBe('Page 1');
  });
});
