// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
      saveStatus: 'idle' as const, savedAt: undefined, onSave: vi.fn(), onSaveAndClose: vi.fn(), onHome: vi.fn(),
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
          onPeekChange={vi.fn()} onExport={vi.fn()} onSave={onSave} onSaveAndClose={vi.fn()} onHome={vi.fn()}
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
      onExport: vi.fn(), onSave, onSaveAndClose, onHome: vi.fn(),
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
          onPeekChange={vi.fn()} onExport={vi.fn()} onSave={vi.fn()} onSaveAndClose={vi.fn()} onHome={vi.fn()}
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
          onPeekChange={vi.fn()} onExport={vi.fn()} onSave={vi.fn()} onSaveAndClose={vi.fn()} onHome={vi.fn()}
        />
      </EditsStoreProvider>,
    );
    expect(screen.getByText('No changes to save')).toBeTruthy();
  });

  it.each([
    ['full', "Couldn't save — not enough space on this device. Download your PDF to keep your work."],
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
          onPeekChange={vi.fn()} onExport={vi.fn()} onSave={vi.fn()} onSaveAndClose={vi.fn()} onHome={vi.fn()}
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
      onExport: vi.fn(), onSave: vi.fn(), onSaveAndClose: vi.fn(), onHome: vi.fn(),
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

  describe('UI/UX review fixes', () => {
    const props = () => ({
      onOpen: vi.fn(), fileName: 'trip.pdf', editMode: false, textAddMode: false,
      imageMode: false, hasEdits: true, exporting: false, saveStatus: 'saved' as const, savedAt: Date.now() - 3 * 60_000,
      zoom: 1, zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn(),
      onEditModeChange: vi.fn(), onTextAddModeChange: vi.fn(), onImageModeChange: vi.fn(),
      onOpenSign: vi.fn(), onOpenChat: vi.fn(), onOpenSettings: vi.fn(), onPeekChange: vi.fn(),
      onExport: vi.fn(), onSave: vi.fn(), onSaveAndClose: vi.fn(), onHome: vi.fn(),
      savedFilesOpen: false, onToggleSavedFiles: vi.fn(),
    });

    it('makes Open PDF a real button that opens the file chooser', () => {
      const { container } = render(<EditsStoreProvider><Toolbar {...props()} /></EditsStoreProvider>);
      const input = container.querySelector<HTMLInputElement>('header input[type="file"]')!;
      const click = vi.spyOn(input, 'click');
      fireEvent.click(screen.getByRole('button', { name: 'Open PDF' }));
      expect(click).toHaveBeenCalledOnce();
      expect(input.tabIndex).toBe(-1);
    });

    it('names the download "Download PDF"', () => {
      render(<EditsStoreProvider><Toolbar {...props()} /></EditsStoreProvider>);
      expect(screen.getByRole('button', { name: 'Download PDF' })).toBeTruthy();
      expect(screen.queryByText(/Export/)).toBeNull();
    });

    it('announces the save state, not the minutes that tick by', () => {
      render(<EditsStoreProvider><Toolbar {...props()} /></EditsStoreProvider>);
      expect(screen.getByRole('status').textContent).toBe('Saved on this device');
      expect(screen.getByRole('status').parentElement?.textContent).toBe('Saved on this device · 3 min ago');
    });

    it('turns a save failure into a red banner with a Download PDF now button', () => {
      const onExport = vi.fn();
      render(<EditsStoreProvider><Toolbar {...props()} saveStatus="full" onExport={onExport} /></EditsStoreProvider>);
      const banner = screen.getByRole('alert');
      expect(banner.textContent).toContain("Couldn't save — not enough space on this device.");
      fireEvent.click(within(banner).getByRole('button', { name: 'Download PDF now' }));
      expect(onExport).toHaveBeenCalledOnce();
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  describe('on a phone', () => {
    const phoneProps = () => ({
      onOpen: vi.fn(), fileName: 'trip.pdf', editMode: false, textAddMode: false,
      imageMode: false, hasEdits: true, exporting: false, saveStatus: 'idle' as const,
      zoom: 1, zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn(),
      onEditModeChange: vi.fn(), onTextAddModeChange: vi.fn(), onImageModeChange: vi.fn(),
      onOpenSign: vi.fn(), onOpenChat: vi.fn(), onOpenSettings: vi.fn(), onPeekChange: vi.fn(),
      onExport: vi.fn(), onSave: vi.fn(), onSaveAndClose: vi.fn(), onHome: vi.fn(),
      savedFilesOpen: false, onToggleSavedFiles: vi.fn(), phoneLayout: true,
    });

    it('shows one row: the logo, Ask, Download PDF and a ☰ for everything else', () => {
      render(<EditsStoreProvider><Toolbar {...phoneProps()} /></EditsStoreProvider>);
      for (const name of ['HighPal', '💬 Ask', 'Download PDF']) expect(screen.getByRole('button', { name })).toBeTruthy();
      const more = screen.getByRole('button', { name: 'More tools' });
      expect(more.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('button', { name: 'Edit text' })).toBeNull();

      fireEvent.click(more);
      expect(more.getAttribute('aria-expanded')).toBe('true');
      for (const group of ['Edit', 'View', 'File']) expect(screen.getByRole('group', { name: group })).toBeTruthy();
      for (const name of ['Edit text', 'Add text', 'Add image', 'Sign', 'Undo document edit', 'Zoom in', 'Saved files', 'Save & close', 'Settings']) {
        expect(screen.getByRole('button', { name })).toBeTruthy();
      }
      expect(screen.getByText('trip.pdf')).toBeTruthy();
    });

    it('closes the panel after choosing a tool, but not after zooming', () => {
      const props = phoneProps();
      render(<EditsStoreProvider><Toolbar {...props} /></EditsStoreProvider>);
      const more = screen.getByRole('button', { name: 'More tools' });
      fireEvent.click(more);
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      expect(props.zoomIn).toHaveBeenCalledOnce();
      expect(more.getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
      expect(props.onEditModeChange).toHaveBeenCalledWith(true);
      expect(more.getAttribute('aria-expanded')).toBe('false');
    });

    it('closes the panel with Escape or a tap outside the bar', () => {
      render(<EditsStoreProvider><Toolbar {...phoneProps()} /></EditsStoreProvider>);
      const more = screen.getByRole('button', { name: 'More tools' });
      fireEvent.click(more);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(more.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(more);
      fireEvent.pointerDown(document.body);
      expect(more.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps a save problem visible without opening the panel', () => {
      render(<EditsStoreProvider><Toolbar {...phoneProps()} saveStatus="full" /></EditsStoreProvider>);
      expect(screen.getByRole('alert').textContent).toContain("Couldn't save");
    });
  });

  it('makes the HighPal logo a button that goes home (Task 82)', () => {
    const onHome = vi.fn();
    const onSaveAndClose = vi.fn();
    const props = {
      onOpen: vi.fn(), fileName: 'contract.pdf', editMode: true, textAddMode: false,
      imageMode: false, hasEdits: true, exporting: false, saveStatus: 'saved' as const,
      zoom: 1, zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn(),
      onEditModeChange: vi.fn(), onTextAddModeChange: vi.fn(), onImageModeChange: vi.fn(),
      onOpenSign: vi.fn(), onOpenChat: vi.fn(), onOpenSettings: vi.fn(), onPeekChange: vi.fn(),
      onExport: vi.fn(), onSave: vi.fn(), onSaveAndClose, onHome,
      savedFilesOpen: true, onToggleSavedFiles: vi.fn(),
    };
    render(<EditsStoreProvider><Toolbar {...props} /></EditsStoreProvider>);
    const logo = screen.getByRole('button', { name: 'HighPal' });
    expect(logo.getAttribute('title')).toBe('Save and go to the home page');
    fireEvent.click(logo);
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onSaveAndClose).not.toHaveBeenCalled();
  });
});
