// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignatureModal } from './SignatureModal';

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
    render(<SignatureModal open onClose={close} onDone={done} />);
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
});
