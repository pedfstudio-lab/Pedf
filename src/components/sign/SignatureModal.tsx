import { useEffect, useRef } from 'react';
import type { SignatureAsset } from '@/lib/tools/signOptions';
import { SignatureMaker } from './SignatureMaker';

export interface SignatureModalProps {
  open: boolean;
  onClose(): void;
  onDone(signature: SignatureAsset): void;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function SignatureModal({ open, onClose, onDone }: SignatureModalProps) {
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [onClose, open]);

  if (!open) return null;
  return <div className="signature-modal-backdrop" onPointerDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialog} className="signature-modal" role="dialog" aria-modal="true" aria-labelledby="signature-modal-title">
      <header><div><h2 id="signature-modal-title">Add a signature</h2>
        <p>Make or pick a signature. You can move and resize it after adding.</p></div>
        <button type="button" aria-label="Close signature maker" onClick={onClose}>×</button>
      </header>
      <SignatureMaker onCancel={onClose} onDone={onDone} />
    </div>
  </div>;
}
