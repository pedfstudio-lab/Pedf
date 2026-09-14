import { useEffect, useState } from 'react';
import { HoldToPeek } from './HoldToPeek';
import { ZOOM_MAX, ZOOM_MIN } from '@/lib/pdf/zoom';
import { useEdits } from '@/state/editsStore';
import type { SaveStatus } from '@/lib/projects/useProjectAutosave';
import { savedAgo } from '@/lib/projects/savedTime';

interface ToolbarProps {
  onOpen: (file: File) => void;
  fileName: string | null;
  editMode: boolean;
  textAddMode: boolean;
  imageMode: boolean;
  hasEdits: boolean;
  exporting: boolean;
  saveStatus: SaveStatus;
  savedAt?: number;
  savedFilesOpen: boolean;
  /** Brief Ctrl/Cmd+S result shown in place of the quiet autosave status. */
  saveNotice?: 'saved' | 'no-changes';
  zoom: number;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  onEditModeChange(enabled: boolean): void;
  onTextAddModeChange(enabled: boolean): void;
  onImageModeChange(enabled: boolean): void;
  onOpenSign(): void;
  onOpenChat(): void;
  onOpenSettings(): void;
  onToggleSavedFiles(): void;
  onPeekChange(peeking: boolean): void;
  onExport(): void;
  /** Ctrl/Cmd+S: save now and keep the file open. */
  onSave(): void;
  /** The Save & close button: save every change, then close the file. */
  onSaveAndClose(): void;
}

const SAVE_TOOLTIP = 'Saved only in this browser on this device. Clearing browser data removes it.';
const SAVE_AND_CLOSE_TOOLTIP = 'Save every change on this device and close the file. Ctrl+S saves without closing.';

export function Toolbar({
  onOpen,
  fileName,
  editMode,
  textAddMode,
  imageMode,
  hasEdits,
  exporting,
  saveStatus,
  savedAt,
  savedFilesOpen,
  saveNotice,
  zoom,
  zoomIn,
  zoomOut,
  zoomReset,
  onEditModeChange,
  onTextAddModeChange,
  onImageModeChange,
  onOpenSign,
  onOpenChat,
  onOpenSettings,
  onToggleSavedFiles,
  onPeekChange,
  onExport,
  onSave,
  onSaveAndClose,
}: ToolbarProps) {
  const { undo, redo, canUndo, canRedo } = useEdits();
  const [, refreshSavedTime] = useState(0);

  useEffect(() => {
    if (saveStatus !== 'saved' || !savedAt) return;
    const timer = window.setInterval(() => refreshSavedTime((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [saveStatus, savedAt]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.altKey
        || (!event.ctrlKey && !event.metaKey)
        || event.key.toLowerCase() !== 's'
      ) return;
      event.preventDefault();
      if (fileName) onSave();
    };
    window.addEventListener('keydown', saveShortcut);
    return () => window.removeEventListener('keydown', saveShortcut);
  }, [fileName, onSave]);

  const statusText = saveNotice === 'saved'
    ? 'All changes saved on this device'
    : saveNotice === 'no-changes'
      ? 'No changes to save'
      : saveStatus === 'saving'
        ? 'Saving…'
        : saveStatus === 'saved' && savedAt
      ? `Saved on this device · ${savedAgo(savedAt)}`
      : saveStatus === 'full'
        ? "Couldn't save — not enough space on this device. Export your PDF to keep your work."
        : saveStatus === 'unavailable'
          ? "Can't save on this device"
          : '';

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-4">
      <span className="text-lg font-semibold tracking-tight text-neutral-900">PEDF Studio</span>
      {fileName && (
        <span className="max-w-[45%] truncate text-sm text-neutral-500" title={fileName}>
          {fileName}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          aria-pressed={savedFilesOpen}
          onClick={onToggleSavedFiles}
          className="whitespace-nowrap rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
        >
          Saved files
        </button>
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo document edit"
          title="Undo (Ctrl+Z)"
          className="w-9 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-base font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↶
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo document edit"
          title="Redo (Ctrl+Shift+Z or Ctrl+Y)"
          className="w-9 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-base font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↷
        </button>
        <div
          className="flex items-center rounded-md border border-neutral-300 bg-white"
          role="group"
          aria-label="Document zoom"
        >
          <button
            type="button"
            onClick={zoomOut}
            disabled={zoom <= ZOOM_MIN}
            aria-label="Zoom out"
            title="Zoom out (Ctrl+-)"
            className="w-8 rounded-l-md py-1.5 text-base font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            −
          </button>
          <button
            type="button"
            onClick={zoomReset}
            aria-label={`Reset zoom to 100% (currently ${Math.round(zoom * 100)}%)`}
            title="Reset zoom (Ctrl+0)"
            className="min-w-14 border-x border-neutral-300 px-2 py-1.5 text-xs font-semibold tabular-nums text-neutral-700 hover:bg-neutral-100"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={zoomIn}
            disabled={zoom >= ZOOM_MAX}
            aria-label="Zoom in"
            title="Zoom in (Ctrl+=)"
            className="w-8 rounded-r-md py-1.5 text-base font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            +
          </button>
        </div>
        <button
          type="button"
          aria-pressed={editMode}
          onClick={() => onEditModeChange(!editMode)}
          disabled={!fileName}
          className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${editMode ? 'bg-blue-600 text-white hover:bg-blue-500' : 'border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100'}`}
        >
          Edit text
        </button>
        <button
          type="button"
          aria-pressed={textAddMode}
          onClick={() => onTextAddModeChange(!textAddMode)}
          disabled={!fileName}
          className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${textAddMode ? 'bg-violet-700 text-white hover:bg-violet-600' : 'border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100'}`}
        >
          Add text
        </button>
        <button
          type="button"
          aria-pressed={imageMode}
          onClick={() => onImageModeChange(!imageMode)}
          disabled={!fileName}
          className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${imageMode ? 'bg-cyan-700 text-white hover:bg-cyan-600' : 'border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100'}`}
        >
          Add image
        </button>
        <button
          type="button"
          onClick={onOpenSign}
          disabled={!fileName}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Sign
        </button>
        <HoldToPeek disabled={!hasEdits} onPeekChange={onPeekChange} />
        <button
          type="button"
          onClick={onOpenChat}
          disabled={!fileName}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          💬 Ask
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
        >
          ⚙ Settings
        </button>
        {statusText && (
          <span
            role="status"
            title={SAVE_TOOLTIP}
            className={`max-w-56 text-right text-xs ${saveStatus === 'full' || saveStatus === 'unavailable' ? 'font-semibold text-red-700' : 'text-neutral-500'}`}
          >
            {statusText}
          </span>
        )}
        <button
          type="button"
          onClick={onSaveAndClose}
          disabled={!fileName || saveStatus === 'saving'}
          title={SAVE_AND_CLOSE_TOOLTIP}
          className="whitespace-nowrap rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save &amp; close
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={!fileName || exporting}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-wait disabled:opacity-40"
        >
          {exporting ? 'Exporting…' : 'Export PDF'}
        </button>
      <label className="cursor-pointer rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">
        Open PDF
        <input
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onOpen(f);
            e.target.value = '';
          }}
        />
      </label>
      </div>
    </header>
  );
}
