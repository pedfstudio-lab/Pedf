import { HoldToPeek } from './HoldToPeek';

interface ToolbarProps {
  onOpen: (file: File) => void;
  fileName: string | null;
  editMode: boolean;
  textAddMode: boolean;
  imageMode: boolean;
  hasEdits: boolean;
  exporting: boolean;
  onEditModeChange(enabled: boolean): void;
  onTextAddModeChange(enabled: boolean): void;
  onImageModeChange(enabled: boolean): void;
  onOpenChat(): void;
  onOpenSettings(): void;
  onPeekChange(peeking: boolean): void;
  onExport(): void;
}

export function Toolbar({
  onOpen,
  fileName,
  editMode,
  textAddMode,
  imageMode,
  hasEdits,
  exporting,
  onEditModeChange,
  onTextAddModeChange,
  onImageModeChange,
  onOpenChat,
  onOpenSettings,
  onPeekChange,
  onExport,
}: ToolbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-4">
      <span className="text-lg font-semibold tracking-tight text-neutral-900">DesiPDF</span>
      {fileName && (
        <span className="max-w-[45%] truncate text-sm text-neutral-500" title={fileName}>
          {fileName}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
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
