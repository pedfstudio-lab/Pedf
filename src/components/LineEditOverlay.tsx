import { useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ScreenRect } from '@/lib/export/coordinates';
import {
  SNAP_THRESHOLD_PX,
  snapAxis,
} from '@/lib/edit/moveSnap';
import type { MoveGuideState, SnapTarget } from '@/lib/edit/moveSnap';

interface LineEditOverlayProps {
  readonly screenRect: ScreenRect;
  readonly zoom: number;
  readonly verticalTargets: readonly SnapTarget[];
  readonly horizontalTargets: readonly SnapTarget[];
  onMoveStateChange(state: MoveGuideState | null): void;
  onMove(dxPt: number, dyPt: number): void;
  onDelete(): void;
  onCancel(): void;
}

export function LineEditOverlay({
  screenRect,
  zoom,
  verticalTargets,
  horizontalTargets,
  onMoveStateChange,
  onMove,
  onDelete,
  onCancel,
}: LineEditOverlayProps) {
  const [moveOffset, setMoveOffset] = useState({ x: 0, y: 0 });
  const controlsAbove = screenRect.top + moveOffset.y > 48;

  useEffect(() => () => onMoveStateChange(null), [onMoveStateChange]);

  const beginMoveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = moveOffset;
    let latestOffset = startOffset;
    event.currentTarget.setPointerCapture(event.pointerId);
    onMoveStateChange({
      crosshair: {
        x: screenRect.left + startOffset.x,
        y: screenRect.top + startOffset.y,
      },
    });

    const move = (moveEvent: PointerEvent) => {
      const rawOffset = {
        x: startOffset.x + moveEvent.clientX - startX,
        y: startOffset.y + moveEvent.clientY - startY,
      };
      const rawLeft = screenRect.left + rawOffset.x;
      const rawTop = screenRect.top + rawOffset.y;
      const xSnap = snapAxis(
        rawLeft,
        rawLeft + screenRect.width / 2,
        rawLeft + screenRect.width,
        verticalTargets,
        SNAP_THRESHOLD_PX,
      );
      const ySnap = snapAxis(
        rawTop,
        rawTop + screenRect.height / 2,
        rawTop + screenRect.height,
        horizontalTargets,
        SNAP_THRESHOLD_PX,
      );
      latestOffset = {
        x: rawOffset.x + (xSnap?.delta ?? 0),
        y: rawOffset.y + (ySnap?.delta ?? 0),
      };
      setMoveOffset(latestOffset);
      onMoveStateChange({
        crosshair: {
          x: screenRect.left + latestOffset.x,
          y: screenRect.top + latestOffset.y,
        },
        ...(xSnap ? { vertical: xSnap.guide } : {}),
        ...(ySnap ? { horizontal: ySnap.guide } : {}),
      });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      onMoveStateChange(null);
    };
    const finish = () => {
      cleanup();
      if (Math.abs(latestOffset.x) < 0.01 && Math.abs(latestOffset.y) < 0.01) return;
      onMove(latestOffset.x / zoom, -latestOffset.y / zoom);
    };
    const cancel = () => {
      cleanup();
      setMoveOffset(startOffset);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  };

  return (
    <div
      className="pointer-events-none absolute isolate z-50"
      style={{
        left: screenRect.left + moveOffset.x,
        top: screenRect.top + moveOffset.y,
        width: Math.max(1, screenRect.width),
        height: Math.max(1, screenRect.height),
      }}
      aria-label="Selected divider line"
    >
      <div className="absolute inset-0 rounded-sm bg-fuchsia-500/40 outline outline-2 outline-fuchsia-500" />
      <div
        role="toolbar"
        aria-label="Divider line actions"
        className={`pointer-events-auto absolute left-0 z-20 flex items-center gap-1 whitespace-nowrap rounded-lg border border-neutral-300 bg-white p-1 shadow-xl ${controlsAbove ? 'bottom-full mb-2' : 'top-full mt-2'}`}
      >
        <button
          type="button"
          aria-label="Drag to move divider line"
          title="Drag to move"
          onPointerDown={beginMoveDrag}
          className="cursor-move rounded bg-fuchsia-600 px-2 py-1 text-xs font-semibold text-white hover:bg-fuchsia-700"
        >
          Move ✥
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
