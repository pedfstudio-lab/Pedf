import { useRef, useState } from 'react';
import { acceptAttribute } from '@/lib/tools/files';
import type { ToolDefinition } from '@/lib/tools/types';

export function ToolDropZone({ tool, onFiles, disabled }: {
  tool: ToolDefinition;
  onFiles(files: File[]): void;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const kind = tool.accepts === 'pdf' ? 'PDF' : tool.accepts === 'image' ? 'image' : 'PDF or image';
  const label = `Choose ${tool.multiple ? 'files' : 'a file'}`;
  return <div className="tool-upload">
    <button type="button" disabled={disabled} className={`tool-drop-zone${dragging ? ' is-dragging' : ''}`}
      onClick={() => input.current?.click()}
      onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) onFiles(Array.from(event.dataTransfer.files));
      }}>
      <span className="tool-icon" aria-hidden="true">↑</span>
      <strong>Drop {tool.multiple ? `${kind} files` : `a ${kind} file`} here</strong>
      <span>or click to choose {tool.multiple ? 'files' : 'a file'}</span>
    </button>
    <input ref={input} type="file" hidden aria-label={label} accept={acceptAttribute(tool.accepts)}
      multiple={tool.multiple} disabled={disabled} onChange={(event) => {
        onFiles(Array.from(event.target.files ?? []));
        event.target.value = '';
      }} />
  </div>;
}
