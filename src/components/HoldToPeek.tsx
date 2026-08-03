interface HoldToPeekProps {
  readonly disabled?: boolean;
  onPeekChange(peeking: boolean): void;
}

export function HoldToPeek({ disabled = false, onPeekChange }: HoldToPeekProps) {
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
      className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
      title="Hold to temporarily reveal the untouched PDF"
    >
      Hold to peek
    </button>
  );
}
