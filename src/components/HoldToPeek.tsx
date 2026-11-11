import { useRef } from 'react';

interface HoldToPeekProps {
  readonly disabled?: boolean;
  onPeekChange(peeking: boolean): void;
}

const isHoldKey = (key: string) => key === ' ' || key === 'Enter';

/** Shows the untouched PDF while held: with the mouse, a finger, or Space/Enter. */
export function HoldToPeek({ disabled = false, onPeekChange }: HoldToPeekProps) {
  const keyHeld = useRef(false);
  const releaseKey = () => {
    if (!keyHeld.current) return;
    keyHeld.current = false;
    onPeekChange(false);
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onPeekChange(true);
      }}
      onPointerUp={() => onPeekChange(false)}
      onPointerCancel={() => onPeekChange(false)}
      onLostPointerCapture={() => onPeekChange(false)}
      onKeyDown={(event) => {
        if (!isHoldKey(event.key)) return;
        event.preventDefault(); // no click, no page scroll
        if (event.repeat || keyHeld.current) return;
        keyHeld.current = true;
        onPeekChange(true);
      }}
      onKeyUp={(event) => {
        if (!isHoldKey(event.key)) return;
        event.preventDefault();
        releaseKey();
      }}
      onBlur={releaseKey}
      className="whitespace-nowrap rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
      title={disabled
        ? 'Make an edit first, then hold this to see the original PDF'
        : 'Hold (or hold Space) to see the original PDF without your edits'}
    >
      Hold to peek
    </button>
  );
}
