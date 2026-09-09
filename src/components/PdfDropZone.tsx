import { useId, useRef, useState } from 'react';
import { isPdf } from '@/lib/site/pdfFile';
import './PdfDropZone.css';

interface PdfDropZoneProps {
  onFile(file: File): void;
  onError?(message: string): void;
  label?: string;
  sublabel?: string;
}

export function PdfDropZone({
  onFile,
  onError,
  label = 'Drag & drop your PDF here',
  sublabel = 'or click to upload',
}: PdfDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  const acceptFile = (file: File | undefined) => {
    if (!file) return;
    if (!isPdf(file)) {
      const message = 'Choose a PDF file.';
      setError(message);
      onError?.(message);
      return;
    }
    setError('');
    onFile(file);
  };

  return (
    <div className="pdf-drop-zone">
      <button
        type="button"
        className={`drop-zone${dragging ? ' drop-zone--active' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          acceptFile(event.dataTransfer.files[0]);
        }}
        aria-describedby={`${helpId}${error && !onError ? ` ${errorId}` : ''}`}
      >
        <span className="drop-zone__icon" aria-hidden="true">
          <svg viewBox="0 0 48 56" fill="none"><path d="M9 3h21l9 9v41H9z" fill="white"/><path d="M30 3v10h9" stroke="#8EC8FF" strokeWidth="3"/><path d="M24 39V22m-7 7 7-7 7 7" stroke="#126BFF" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
        <span><strong>{label}</strong><small id={helpId}>{sublabel}</small></span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        aria-label={label}
        hidden
        onChange={(event) => {
          acceptFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {!onError && <p id={errorId} className="drop-zone__error" role="alert">{error}</p>}
    </div>
  );
}
