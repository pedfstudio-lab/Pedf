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
      saveStatus: 'idle' as const, savedAt: undefined, onSave: vi.fn(), onSaveAndClose: vi.fn(),
      savedFilesOpen: true, onToggleSavedFiles: vi.fn(),
    };
    const { rerender } = render(<EditsStoreProvider><Toolbar {...props} fileName={null} /></EditsStoreProvider>);
    expect((screen.getByRole('button', { name: 'Sign' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<EditsStoreProvider><Toolbar {...props} fileName="form.pdf" /></EditsStoreProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(openSign).toHaveBeenCalledTimes(1);
  });

  it('prevents the browser Save-page shortcut even before a PDF is open', () => {
    const onSave = vi.fn();
    render(
      <EditsStoreProvider>
        <Toolbar
          onOpen={vi.fn()} fileName={null} editMode={false} textAddMode={false}
          imageMode={false} hasEdits={false} exporting={false} saveStatus="idle"
          savedFilesOpen onToggleSavedFiles={vi.fn()}
          zoom={1} zoomIn={vi.fn()} zoomOut={vi.fn()} zoomReset={vi.fn()}
          onEditModeChange={vi.fn()} onTextAddModeChange={vi.fn()} onImageModeChange={vi.fn()}
          onOpenSign={vi.fn()} onOpenChat={vi.fn()} onOpenSettings={vi.fn()}
          onPeekChange={vi.fn()} onExport={vi.fn()} onSave={onSave} onSaveAndClose={vi.fn()}
        />
      </EditsStoreProvider>,
    );
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves and closes with the button, and only saves with Ctrl/Cmd+S', () => {
    const onSave = vi.fn();
    const onSaveAndClose = vi.fn();
    const props = {
      onOpen: vi.fn(), fileName: 'contract.pdf', editMode: false, textAddMode: false,
      imageMode: false, hasEdits: false, exporting: false, saveStatus: 'saved' as const,
      savedAt: Date.now(), zoom: 1, zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn(),
      onEditModeChange: vi.fn(), onTextAddModeChange: vi.fn(), onImageModeChange: vi.fn(),
      onOpenSign: vi.fn(), onOpenChat: vi.fn(), onOpenSettings: vi.fn(), onPeekChange: vi.fn(),
      onExport: vi.fn(), onSave, onSaveAndClose,
      savedFilesOpen: true, onToggleSavedFiles: vi.fn(),
    };
    render(<EditsStoreProvider><Toolbar {...props} /></EditsStoreProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));
    expect(onSaveAndClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();

    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSaveAndClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText(/Saved on this device/)).toBeTruthy();
  });

  it('confirms a Ctrl/Cmd+S save briefly', () => {
    render(
      <EditsStoreProvider>
        <Toolbar
          onOpen={vi.fn()} fileName="contract.pdf" editMode={false} textAddMode={false}
          imageMode={false} hasEdits={false} exporting={false} saveStatus="saved" savedAt={Date.now()} saveNotice="saved"
          savedFilesOpen onToggleSavedFiles={vi.fn()}
          zoom={1} zoomIn={vi.fn()} zoomOut={vi.fn()} zoomReset={vi.fn()}
          onEditModeChange={vi.fn()} onTextAddModeChange={vi.fn()} onImageModeChange={vi.fn()}
          onOpenSign={vi.fn()} onOpenChat={vi.fn()} onOpenSettings={vi.fn()}
          onPeekChange={vi.fn()} onExport={vi.fn()} onSave={vi.fn()} onSaveAndClose={vi.fn()}
        />
      </EditsStoreProvider>,
    );
    expect(screen.getByText('All changes saved on this device')).toBeTruthy();
  });

  it('reports that Ctrl/Cmd+S had no document changes to save', () => {
    render(
      <EditsStoreProvider>
        <Toolbar
          onOpen={vi.fn()} fileName="contract.pdf" editMode={false} textAddMode={false}
          imageMode={false} hasEdits={false} exporting={false} saveStatus="idle" saveNotice="no-changes"
          savedFilesOpen onToggleSavedFiles={vi.fn()}
          zoom={1} zoomIn={vi.fn()} zoomOut={vi.fn()} zoomReset={vi.fn()}
          onEditModeChange={vi.fn()} onTextAddModeChange={vi.fn()} onImageModeChange={vi.fn()}
          onOpenSign={vi.fn()} onOpenChat={vi.fn()} onOpenSettings={vi.fn()}
          onPeekChange={vi.fn()} onExport={vi.fn()} onSave={vi.fn()} onSaveAndClose={vi.fn()}
        />
      </EditsStoreProvider>,
    );
    expect(screen.getByText('No changes to save')).toBeTruthy();
  });

  it.each([
    ['full', "Couldn't save — not enough space on this device. Export your PDF to keep your work."],
    ['unavailable', "Can't save on this device"],
  ] as const)('shows the %s storage status', (saveStatus, message) => {
    render(
      <EditsStoreProvider>
        <Toolbar
          onOpen={vi.fn()} fileName="contract.pdf" editMode={false} textAddMode={false}
          imageMode={false} hasEdits={false} exporting={false} saveStatus={saveStatus}
          savedFilesOpen onToggleSavedFiles={vi.fn()}
          zoom={1} zoomIn={vi.fn()} zoomOut={vi.fn()} zoomReset={vi.fn()}
          onEditModeChange={vi.fn()} onTextAddModeChange={vi.fn()} onImageModeChange={vi.fn()}
          onOpenSign={vi.fn()} onOpenChat={vi.fn()} onOpenSettings={vi.fn()}
          onPeekChange={vi.fn()} onExport={vi.fn()} onSave={vi.fn()} onSaveAndClose={vi.fn()}
        />
      </EditsStoreProvider>,
    );
    expect(screen.getByText(message)).toBeTruthy();
  });

  it('toggles the Saved files surface and exposes its pressed state', () => {
    const onToggleSavedFiles = vi.fn();
    const props = {
      onOpen: vi.fn(), fileName: null, editMode: false, textAddMode: false,
      imageMode: false, hasEdits: false, exporting: false, saveStatus: 'idle' as const,
      zoom: 1, zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn(),
      onEditModeChange: vi.fn(), onTextAddModeChange: vi.fn(), onImageModeChange: vi.fn(),
      onOpenSign: vi.fn(), onOpenChat: vi.fn(), onOpenSettings: vi.fn(), onPeekChange: vi.fn(),
      onExport: vi.fn(), onSave: vi.fn(), onSaveAndClose: vi.fn(),
      savedFilesOpen: true, onToggleSavedFiles,
    };
    const { rerender } = render(
      <EditsStoreProvider><Toolbar {...props} /></EditsStoreProvider>,
    );
    const button = screen.getByRole('button', { name: 'Saved files' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onToggleSavedFiles).toHaveBeenCalledTimes(1);

    rerender(
      <EditsStoreProvider><Toolbar {...props} savedFilesOpen={false} /></EditsStoreProvider>,
    );
    expect(screen.getByRole('button', { name: 'Saved files' }).getAttribute('aria-pressed')).toBe('false');
  });
});
