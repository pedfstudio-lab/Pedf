interface ToolbarProps {
  onOpen: (file: File) => void;
  fileName: string | null;
}

export function Toolbar({ onOpen, fileName }: ToolbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-4">
      <span className="text-lg font-semibold tracking-tight text-neutral-900">DesiPDF</span>
      {fileName && (
        <span className="max-w-[45%] truncate text-sm text-neutral-500" title={fileName}>
          {fileName}
        </span>
      )}
      <label className="ml-auto cursor-pointer rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">
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
    </header>
  );
}
