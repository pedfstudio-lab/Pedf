import { useEffect, useState } from 'react';
import { HoldToPeek } from './HoldToPeek';
import { ZOOM_MAX, ZOOM_MIN } from '@/lib/pdf/zoom';
import { useEdits } from '@/state/editsStore';
import type { SaveStatus } from '@/lib/projects/useProjectAutosave';
import { savedAgo } from '@/lib/projects/savedTime';
import { TranslationControls } from './TranslationControls';

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
  onTranslate?(): void;
  onOpenSettings(): void;
  onToggleSavedFiles(): void;
  onPeekChange(peeking: boolean): void;
  onExport(): void;
  /** Ctrl/Cmd+S: save now and keep the file open. */
  onSave(): void;
  /** The Save & close button: save every change, then close the file. */
  onSaveAndClose(): void;
  /** The logo: Save & close, then the landing page. */
  onHome(): void;
}

const SAVE_TOOLTIP = 'Saved only in this browser on this device. Clearing browser data removes it.';
const SAVE_AND_CLOSE_TOOLTIP = 'Save every change on this device and close the file. Ctrl+S saves without closing.';
const PLAIN_BUTTON = 'whitespace-nowrap rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40';
/** A switched-on mode. Each mode adds its colour, darker on hover so the white text stays readable. */
const PRESSED_BUTTON = 'whitespace-nowrap rounded-md border border-transparent px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40';
const ICON_BUTTON = 'w-8 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-base font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40';

function Divider() {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-neutral-300" />;
}

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
  onTranslate,
  onOpenSettings,
  onToggleSavedFiles,
  onPeekChange,
  onExport,
  onSave,
  onSaveAndClose,
  onHome,
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
  const saveProblem = saveStatus === 'full' || saveStatus === 'unavailable';

  // Two rows, so every label fits on one line on a 1366px laptop:
  // the file (name, save status, file actions) above the editing tools.
  // In a narrow window the buttons move onto another line instead of off the screen.
  return (
    <header className="shrink-0 border-b border-neutral-200 bg-white">
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5">
        <div className="flex min-w-0 grow basis-64 items-center gap-3">
          <button
            type="button"
            onClick={onHome}
            title="Save and go to the home page"
            className="shrink-0 cursor-pointer whitespace-nowrap rounded text-lg font-semibold tracking-tight text-neutral-900 hover:text-neutral-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            PEDF Studio
          </button>
          {fileName && (
            <span className="min-w-0 truncate text-sm text-neutral-600" title={fileName}>
              {fileName}
            </span>
          )}
          {statusText && (
            <span
              role="status"
              title={SAVE_TOOLTIP}
              className={`text-xs ${saveProblem ? 'max-w-md font-semibold text-red-700' : 'shrink-0 whitespace-nowrap text-neutral-500'}`}
            >
              {statusText}
            </span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className={PLAIN_BUTTON}
          >
            ⚙ Settings
          </button>
          <button
            type="button"
            onClick={onSaveAndClose}
            disabled={!fileName || saveStatus === 'saving'}
            title={SAVE_AND_CLOSE_TOOLTIP}
            className={PLAIN_BUTTON}
          >
            Save &amp; close
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={!fileName || exporting}
            className="whitespace-nowrap rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-40"
          >
            {exporting ? 'Exporting…' : 'Export PDF'}
          </button>
          <label className="cursor-pointer whitespace-nowrap rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">
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
      </div>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 border-t border-neutral-100 bg-neutral-50 px-4 py-1">
        <button
          type="button"
          aria-pressed={savedFilesOpen}
          onClick={onToggleSavedFiles}
          className={PLAIN_BUTTON}
        >
          Saved files
        </button>
        <Divider />
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo document edit"
          title="Undo (Ctrl+Z)"
          className={ICON_BUTTON}
        >
          ↶
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo document edit"
          title="Redo (Ctrl+Shift+Z or Ctrl+Y)"
          className={ICON_BUTTON}
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
            className="w-7 rounded-l-md py-1.5 text-base font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            −
          </button>
          <button
            type="button"
            onClick={zoomReset}
            aria-label={`Reset zoom to 100% (currently ${Math.round(zoom * 100)}%)`}
            title="Reset zoom (Ctrl+0)"
            className="min-w-12 border-x border-neutral-300 px-2 py-1.5 text-xs font-semibold tabular-nums text-neutral-700 hover:bg-neutral-100"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={zoomIn}
            disabled={zoom >= ZOOM_MAX}
            aria-label="Zoom in"
            title="Zoom in (Ctrl+=)"
            className="w-7 rounded-r-md py-1.5 text-base font-semibold text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            +
          </button>
        </div>
        <Divider />
        <button
          type="button"
          aria-pressed={editMode}
          onClick={() => onEditModeChange(!editMode)}
          disabled={!fileName}
          className={editMode ? `${PRESSED_BUTTON} bg-blue-600 hover:bg-blue-700` : PLAIN_BUTTON}
        >
          Edit text
        </button>
        <button
          type="button"
          aria-pressed={textAddMode}
          onClick={() => onTextAddModeChange(!textAddMode)}
          disabled={!fileName}
          className={textAddMode ? `${PRESSED_BUTTON} bg-violet-700 hover:bg-violet-800` : PLAIN_BUTTON}
        >
          Add text
        </button>
        <button
          type="button"
          aria-pressed={imageMode}
          onClick={() => onImageModeChange(!imageMode)}
          disabled={!fileName}
          className={imageMode ? `${PRESSED_BUTTON} bg-cyan-700 hover:bg-cyan-800` : PLAIN_BUTTON}
        >
          Add image
        </button>
        <button
          type="button"
          onClick={onOpenSign}
          disabled={!fileName}
          className={PLAIN_BUTTON}
        >
          Sign
        </button>
        <HoldToPeek disabled={!hasEdits} onPeekChange={onPeekChange} />
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenChat}
            disabled={!fileName}
            className={PLAIN_BUTTON}
          >
            💬 Ask
          </button>
          <TranslationControls disabled={!fileName} onTranslate={onTranslate} />
        </div>
      </div>
    </header>
  );
}
