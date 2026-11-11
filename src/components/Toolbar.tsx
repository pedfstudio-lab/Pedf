import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
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
  /** A phone-sized screen: one row (logo, Ask, Download PDF) and a ☰ panel with the rest. */
  phoneLayout?: boolean;
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
const MORE_PANEL_ID = 'toolbar-more-tools';

function Divider() {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-neutral-300" />;
}

/** A labelled row of the phone ☰ panel. */
function PanelGroup({ label, children, keepOpen = false }: { readonly label: string; readonly children: ReactNode; readonly keepOpen?: boolean }) {
  return (
    <div role="group" aria-label={label} className="grid gap-1.5" data-keep-more-open={keepOpen || undefined}>
      <span aria-hidden="true" className="text-xs font-semibold uppercase tracking-wide text-neutral-600">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
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
  phoneLayout = false,
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
  const [moreOpen, setMoreOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (!phoneLayout) setMoreOpen(false);
  }, [phoneLayout]);

  // The ☰ panel closes on Escape or a tap anywhere outside the top bar.
  useEffect(() => {
    if (!moreOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [moreOpen]);

  const statusText = saveNotice === 'saved'
    ? 'All changes saved on this device'
    : saveNotice === 'no-changes'
      ? 'No changes to save'
      : saveStatus === 'saving'
        ? 'Saving…'
        : saveStatus === 'saved' && savedAt
      ? `Saved on this device · ${savedAgo(savedAt)}`
      : saveStatus === 'full'
        ? "Couldn't save — not enough space on this device. Download your PDF to keep your work."
        : saveStatus === 'unavailable'
          ? "Can't save on this device"
          : '';
  const saveProblem = saveStatus === 'full' || saveStatus === 'unavailable';

  // Each control is written once; the computer and phone layouts only arrange them.
  const brand = (
    <button
      type="button"
      onClick={onHome}
      title="Save and go to the home page"
      className={`min-w-0 cursor-pointer truncate whitespace-nowrap rounded font-semibold tracking-tight text-neutral-900 hover:text-neutral-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${phoneLayout ? 'text-base' : 'shrink-0 text-lg'}`}
    >
      PEDF Studio
    </button>
  );
  const fileLabel = fileName && (
    <span className="min-w-0 truncate text-sm text-neutral-600" title={fileName}>
      {fileName}
    </span>
  );
  // Screen readers hear the save state when it changes, not "Saved · 3 min ago" every minute:
  // the ticking time sits outside the announced part.
  const savedTime = !saveNotice && saveStatus === 'saved' && savedAt ? savedAgo(savedAt) : '';
  const status = statusText && !saveProblem && (
    <span title={SAVE_TOOLTIP} className="shrink-0 whitespace-nowrap text-xs text-neutral-500">
      <span role="status">{savedTime ? 'Saved on this device' : statusText}</span>
      {savedTime && <span> · {savedTime}</span>}
    </span>
  );
  const saveProblemBanner = saveProblem && (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
      <span className="font-semibold">{statusText}</span>
      <button
        type="button"
        onClick={onExport}
        disabled={!fileName || exporting}
        className="whitespace-nowrap rounded-md bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-40"
      >
        Download PDF now
      </button>
    </div>
  );
  const settingsButton = (
    <button type="button" onClick={onOpenSettings} aria-label="Settings" className={PLAIN_BUTTON}>
      ⚙ Settings
    </button>
  );
  const saveAndCloseButton = (
    <button
      type="button"
      onClick={onSaveAndClose}
      disabled={!fileName || saveStatus === 'saving'}
      title={SAVE_AND_CLOSE_TOOLTIP}
      className={PLAIN_BUTTON}
    >
      Save &amp; close
    </button>
  );
  const exportButton = (
    <button
      type="button"
      onClick={onExport}
      disabled={!fileName || exporting}
      className="shrink-0 whitespace-nowrap rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-40"
    >
      {exporting ? 'Preparing PDF…' : 'Download PDF'}
    </button>
  );
  // A real button (reachable by keyboard and announced as a button) that opens a hidden
  // file chooser. Outlined, so the green Download PDF stays the one strong button.
  const openPdfButton = (
    <>
      <button type="button" onClick={() => fileInputRef.current?.click()} className={PLAIN_BUTTON}>
        Open PDF
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        tabIndex={-1}
        aria-label="Open PDF"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onOpen(f);
          e.target.value = '';
        }}
      />
    </>
  );
  const savedFilesButton = (
    <button type="button" aria-pressed={savedFilesOpen} onClick={onToggleSavedFiles} className={PLAIN_BUTTON}>
      Saved files
    </button>
  );
  const undoButton = (
    <button type="button" onClick={undo} disabled={!canUndo} aria-label="Undo document edit" title="Undo (Ctrl+Z)" className={ICON_BUTTON}>
      ↶
    </button>
  );
  const redoButton = (
    <button type="button" onClick={redo} disabled={!canRedo} aria-label="Redo document edit" title="Redo (Ctrl+Shift+Z or Ctrl+Y)" className={ICON_BUTTON}>
      ↷
    </button>
  );
  const zoomControls = (
    <div className="flex items-center rounded-md border border-neutral-300 bg-white" role="group" aria-label="Document zoom">
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
  );
  const editTextButton = (
    <button
      type="button"
      aria-pressed={editMode}
      onClick={() => onEditModeChange(!editMode)}
      disabled={!fileName}
      className={editMode ? `${PRESSED_BUTTON} bg-blue-600 hover:bg-blue-700` : PLAIN_BUTTON}
    >
      Edit text
    </button>
  );
  const addTextButton = (
    <button
      type="button"
      aria-pressed={textAddMode}
      onClick={() => onTextAddModeChange(!textAddMode)}
      disabled={!fileName}
      className={textAddMode ? `${PRESSED_BUTTON} bg-violet-700 hover:bg-violet-800` : PLAIN_BUTTON}
    >
      Add text
    </button>
  );
  const addImageButton = (
    <button
      type="button"
      aria-pressed={imageMode}
      onClick={() => onImageModeChange(!imageMode)}
      disabled={!fileName}
      className={imageMode ? `${PRESSED_BUTTON} bg-cyan-700 hover:bg-cyan-800` : PLAIN_BUTTON}
    >
      Add image
    </button>
  );
  const signButton = (
    <button type="button" onClick={onOpenSign} disabled={!fileName} className={PLAIN_BUTTON}>
      Sign
    </button>
  );
  const peekButton = <HoldToPeek disabled={!hasEdits} onPeekChange={onPeekChange} />;
  const askButton = (
    <button type="button" onClick={onOpenChat} disabled={!fileName} className={`shrink-0 ${PLAIN_BUTTON}`}>
      💬 Ask
    </button>
  );

  if (phoneLayout) {
    // Choosing a tool closes the panel so the page shows again; undo, zoom, peek and
    // Translate keep it open (they are tapped repeatedly or open their own menu).
    const closeAfterChoice = (event: ReactMouseEvent) => {
      const control = (event.target as HTMLElement).closest('button, label');
      if (control && !control.closest('[data-keep-more-open]')) setMoreOpen(false);
    };
    return (
      <header ref={headerRef} className="relative shrink-0 border-b border-neutral-200 bg-white">
        <div className="flex h-12 items-center gap-1.5 px-3">
          {brand}
          <div className="ml-auto flex items-center gap-1.5">
            {askButton}
            {exportButton}
            <button
              type="button"
              aria-expanded={moreOpen}
              aria-controls={MORE_PANEL_ID}
              aria-label="More tools"
              title="More tools"
              onClick={() => setMoreOpen((open) => !open)}
              className={`shrink-0 rounded-md border px-2.5 py-1 text-lg leading-6 ${moreOpen ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-100'}`}
            >
              ☰
            </button>
          </div>
        </div>
        {saveProblemBanner}
        {/* Hidden, not removed, so the file input and Translate keep working while it is closed. */}
        <div
          id={MORE_PANEL_ID}
          hidden={!moreOpen}
          onClick={closeAfterChoice}
          className="absolute inset-x-0 top-full z-[180] grid gap-3 border-b border-neutral-200 bg-white p-3 shadow-lg"
        >
          {(fileLabel || status) && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {fileLabel}
              {status}
            </div>
          )}
          <PanelGroup label="Edit">
            {editTextButton}
            {addTextButton}
            {addImageButton}
            {signButton}
          </PanelGroup>
          <PanelGroup label="View" keepOpen>
            {undoButton}
            {redoButton}
            {zoomControls}
            {peekButton}
            <TranslationControls
              disabled={!fileName}
              onTranslate={() => {
                onTranslate?.();
                setMoreOpen(false);
              }}
            />
          </PanelGroup>
          <PanelGroup label="File">
            {savedFilesButton}
            {saveAndCloseButton}
            {openPdfButton}
            {settingsButton}
          </PanelGroup>
        </div>
      </header>
    );
  }

  // Two rows, so every label fits on one line on a 1366px laptop:
  // the file (name, save status, file actions) above the editing tools.
  // In a narrow window the buttons move onto another line instead of off the screen.
  return (
    <header ref={headerRef} className="shrink-0 border-b border-neutral-200 bg-white">
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5">
        <div className="flex min-w-0 grow basis-64 items-center gap-3">
          {brand}
          {fileLabel}
          {status}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {settingsButton}
          {saveAndCloseButton}
          {exportButton}
          {openPdfButton}
        </div>
      </div>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 border-t border-neutral-100 bg-neutral-50 px-4 py-1">
        {savedFilesButton}
        <Divider />
        {undoButton}
        {redoButton}
        {zoomControls}
        <Divider />
        {editTextButton}
        {addTextButton}
        {addImageButton}
        {signButton}
        {peekButton}
        <div className="ml-auto flex items-center gap-1.5">
          {askButton}
          <TranslationControls disabled={!fileName} onTranslate={onTranslate} />
        </div>
      </div>
      {saveProblemBanner}
    </header>
  );
}
