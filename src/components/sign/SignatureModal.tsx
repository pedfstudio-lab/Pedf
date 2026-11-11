import { useEffect, useRef, useState } from 'react';
import type { SignatureAsset } from '@/lib/tools/signOptions';
import { SignatureMaker } from './SignatureMaker';

export interface SignatureModalProps {
  open: boolean;
  /** Pages in the document. The page choice shows when there are two or more. */
  pageCount: number;
  /** The page the user is looking at: where the signature goes unless they pick another. */
  currentPage: number;
  onClose(): void;
  onDone(signature: SignatureAsset, pageIndex: number): void;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** "Page 6 (this page, last page)": says where the signature lands without scrolling to look. */
export function signaturePageLabel(index: number, pageCount: number, currentPage: number): string {
  const notes = [index === currentPage ? 'this page' : '', index === pageCount - 1 ? 'last page' : ''].filter(Boolean);
  return `Page ${index + 1}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

export function SignatureModal(props: SignatureModalProps) {
  // A fresh dialog each time it opens, so the page choice starts on the page in view.
  return props.open ? <SignatureDialog {...props} /> : null;
}

function SignatureDialog({ pageCount, currentPage, onClose, onDone }: SignatureModalProps) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState(() => Math.min(Math.max(0, currentPage), Math.max(0, pageCount - 1)));

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      dialog.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  return <div className="signature-modal-backdrop" onPointerDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialog} className="signature-modal" role="dialog" aria-modal="true" aria-labelledby="signature-modal-title">
      <header><div><h2 id="signature-modal-title">Add a signature</h2>
        <p>Make or pick a signature. You can move and resize it after adding.</p></div>
        <button type="button" aria-label="Close signature maker" onClick={onClose}>×</button>
      </header>
      {pageCount > 1 && <div className="signature-page-choice">
        <label htmlFor="signature-page">Add to</label>
        <select id="signature-page" value={page} onChange={(event) => setPage(Number(event.target.value))}>
          {Array.from({ length: pageCount }, (_, index) => (
            <option key={index} value={index}>{signaturePageLabel(index, pageCount, currentPage)}</option>
          ))}
        </select>
      </div>}
      <SignatureMaker onCancel={onClose} onDone={(signature) => onDone(signature, page)} />
    </div>
  </div>;
}
