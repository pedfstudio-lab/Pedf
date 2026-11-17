import { useId, useRef, useState } from 'react';
import { isPdf } from '@/lib/site/pdfFile';
import './PdfDropZone.css';

interface PdfDropZoneProps {
  onFile(file: File): void;
  onError?(message: string): void;
  label?: string;
  sublabel?: string;
  /**
   * "wide": the home page's first screen. A wide drop area with a marigold "Choose your
   * PDF" button inside; on phones it stacks into one big "Tap to choose your PDF" button.
   */
  variant?: 'standard' | 'wide';
}

/**
 * A phone or tablet: no dragging, and people tap rather than click. A touchscreen laptop
 * still has a trackpad or mouse (a "fine" pointer), so it keeps the drag-and-click words.
 */
function isTouchScreen(): boolean {
  try {
    return typeof matchMedia === 'function'
      && matchMedia('(pointer: coarse)').matches
      && !matchMedia('(any-pointer: fine)').matches;
  } catch {
    return false;
  }
}

// Never "upload": the PDF is opened on this device, which is the whole promise.
export function PdfDropZone({
  onFile,
  onError,
  label: givenLabel,
  sublabel: givenSublabel,
  variant = 'standard',
}: PdfDropZoneProps) {
  const [touch] = useState(isTouchScreen);
  const wide = variant === 'wide';
  const label = givenLabel ?? (touch ? 'Tap to choose your PDF' : wide ? 'Drop your PDF here' : 'Drag & drop your PDF here');
  const sublabel = givenSublabel ?? (touch || wide ? 'It stays on your device.' : 'or click to choose it. It stays on your computer.');
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const chooseText = touch ? 'Tap to choose your PDF' : 'Choose your PDF';
  // Touch-screen laptops (wide screens) can still drop a file, so there the line says so; phones
  // keep "It stays on your device." PdfDropZone.css shows one or the other by screen width.
  const touchLaptopLine = 'Drop your PDF here';

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
    <div className={`pdf-drop-zone${wide ? ' pdf-drop-zone--wide' : ''}`}>
      <button
        type="button"
        className={`drop-zone${wide ? ' drop-zone--wide' : ''}${wide && touch ? ' drop-zone--touch' : ''}${dragging ? ' drop-zone--active' : ''}`}
        // The whole area is the one button; the marigold "Choose your PDF" inside is its look.
        // Its spoken name is the words visible inside it (hidden ones drop out by themselves), so
        // screen readers read each once and voice control ("click Choose your PDF") works.
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
        // The line under the heading is already part of the name, so only an error is added here.
        aria-describedby={error && !onError ? errorId : undefined}
      >
        <span className="drop-zone__icon" aria-hidden="true">
          <svg viewBox="0 0 48 56" fill="none"><path d="M9 3h21l9 9v41H9z" fill="white"/><path d="M30 3v10h9" style={{ stroke: 'var(--color-accent)' }} strokeWidth="3"/><path d="M24 39V22m-7 7 7-7 7 7" style={{ stroke: 'var(--color-site-brand)' }} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
        {/* The {' '} spaces keep words apart for tools that read the text (layout ignores them). */}
        <span className="drop-zone__text"><strong>{label}</strong>{' '}<small id={helpId}>
          {wide && touch
            ? <><span className="drop-zone__line-wide">{touchLaptopLine}</span><span className="drop-zone__line-narrow">{sublabel}</span></>
            : sublabel}
        </small></span>
        {wide && <>
          {' '}<span className="drop-zone__or">or</span>
          {' '}<span className="drop-zone__choose">{chooseText}</span>
        </>}
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
