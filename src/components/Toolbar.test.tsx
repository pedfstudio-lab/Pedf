// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditsStoreProvider } from '@/state/editsStore';
import { Toolbar } from './Toolbar';

afterEach(cleanup);

describe('Toolbar signature action', () => {
  it('opens the shared signature maker only when a PDF is open', () => {
    const openSign = vi.fn();
    const props = {
      onOpen: vi.fn(), editMode: false, textAddMode: false, imageMode: false, hasEdits: false, exporting: false,
      zoom: 1, zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn(), onEditModeChange: vi.fn(),
      onTextAddModeChange: vi.fn(), onImageModeChange: vi.fn(), onOpenSign: openSign, onOpenChat: vi.fn(),
      onOpenSettings: vi.fn(), onPeekChange: vi.fn(), onExport: vi.fn(),
    };
    const { rerender } = render(<EditsStoreProvider><Toolbar {...props} fileName={null} /></EditsStoreProvider>);
    expect((screen.getByRole('button', { name: 'Sign' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<EditsStoreProvider><Toolbar {...props} fileName="form.pdf" /></EditsStoreProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(openSign).toHaveBeenCalledTimes(1);
  });
});
