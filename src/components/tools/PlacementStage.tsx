/* eslint-disable react-refresh/only-export-components */
import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useElementSize } from '@/lib/edit/floatingToolbar';

const SNAP = 0.02;
const NUDGE = 0.01;
const NUDGE_BIG = 0.05;

export interface PlacementLimits { minX: number; maxX: number; minY: number; maxY: number }
export interface PlacementValue {
  x: number;
  y: number;
  widthShare: number;
  heightShare: number;
  /** Clockwise CSS angle. */
  angle?: number;
}

interface LivePlacement extends PlacementValue { snapX: boolean; snapY: boolean }

export interface PlacementStageProps {
  pageImage: string;
  imageAlt: string;
  pageWidth: number;
  pageHeight: number;
  value: PlacementValue;
  onChange(value: PlacementValue): void;
  disabled?: boolean;
  limits?: PlacementLimits;
  resizable?: boolean;
  aspectRatio?: number;
  minSizePx?: number;
  className?: string;
  handleClassName?: string;
  label?: string;
  title?: string;
  style?: React.CSSProperties;
  onInteractionChange?(active: boolean): void;
  children?: ReactNode | ((placement: PlacementValue, active: boolean, stageWidthPx: number) => ReactNode);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function placementLimits(value: Pick<PlacementValue, 'widthShare' | 'heightShare'>): PlacementLimits {
  return {
    minX: Math.min(0.5, value.widthShare / 2),
    maxX: Math.max(0.5, 1 - value.widthShare / 2),
    minY: Math.min(0.5, value.heightShare / 2),
    maxY: Math.max(0.5, 1 - value.heightShare / 2),
  };
}

function snapSpot(x: number, y: number, limits: PlacementLimits): Pick<LivePlacement, 'x' | 'y' | 'snapX' | 'snapY'> {
  let snapX = false;
  let snapY = false;
  if (Math.abs(x - 0.5) < SNAP) { x = 0.5; snapX = true; }
  else if (Math.abs(x - limits.minX) < SNAP) x = limits.minX;
  else if (Math.abs(x - limits.maxX) < SNAP) x = limits.maxX;
  if (Math.abs(y - 0.5) < SNAP) { y = 0.5; snapY = true; }
  else if (Math.abs(y - limits.minY) < SNAP) y = limits.minY;
  else if (Math.abs(y - limits.maxY) < SNAP) y = limits.maxY;
  return {
    x: clamp(x, limits.minX, limits.maxX),
    y: clamp(y, limits.minY, limits.maxY),
    snapX,
    snapY,
  };
}

export function PlacementStage({
  pageImage,
  imageAlt,
  pageWidth,
  pageHeight,
  value,
  onChange,
  disabled = false,
  limits,
  resizable = false,
  aspectRatio = 1,
  minSizePx = 40,
  className = '',
  handleClassName = '',
  label = 'Move the item. Drag it, or use the arrow keys.',
  title = 'Drag to place',
  style,
  onInteractionChange,
  children,
}: PlacementStageProps) {
  const stage = useRef<HTMLDivElement | null>(null);
  const [measureStage, stageSize] = useElementSize<HTMLDivElement>();
  const stageRef = useCallback((node: HTMLDivElement | null) => {
    stage.current = node;
    measureStage(node);
  }, [measureStage]);
  const [live, setLive] = useState<LivePlacement | null>(null);
  const current = live ?? { ...value, snapX: false, snapY: false };
  const active = live !== null;

  const setActive = useCallback((next: LivePlacement | null) => {
    setLive(next);
    onInteractionChange?.(next !== null);
  }, [onInteractionChange]);

  const beginMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    const rect = stage.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* window listeners still track it */ }
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = value;
    const fixedLimits = limits ?? placementLimits(origin);
    let latest: LivePlacement = { ...origin, snapX: false, snapY: false };
    let moved = false;
    setActive(latest);
    const move = (moveEvent: PointerEvent) => {
      moved = true;
      latest = {
        ...origin,
        ...snapSpot(
          origin.x + (moveEvent.clientX - startX) / rect.width,
          origin.y + (moveEvent.clientY - startY) / rect.height,
          fixedLimits,
        ),
      };
      setLive(latest);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
    };
    const finish = () => {
      cleanup();
      if (moved) onChange(latest);
      setActive(null);
    };
    const cancel = () => { cleanup(); setActive(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  };

  const nudge = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? NUDGE_BIG : NUDGE;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    const fixedLimits = limits ?? placementLimits(value);
    onChange({
      ...value,
      x: clamp(value.x + dx, fixedLimits.minX, fixedLimits.maxX),
      y: clamp(value.y + dy, fixedLimits.minY, fixedLimits.maxY),
    });
  };

  const beginResize = (corner: 'nw' | 'ne' | 'sw' | 'se', event: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || !resizable || event.button !== 0) return;
    const rect = stage.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    event.preventDefault();
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* window listeners still track it */ }
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = value;
    const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
    const heightPerWidth = pageWidth / (pageHeight * ratio);
    const horizontal = corner.endsWith('e') ? 1 : -1;
    const vertical = corner.startsWith('s') ? 1 : -1;
    const fixedX = origin.x - horizontal * origin.widthShare / 2;
    const fixedY = origin.y - vertical * origin.heightShare / 2;
    const minWidth = Math.min(1, Math.max(0.001, minSizePx / rect.width));
    const maxWidthX = horizontal > 0 ? 1 - fixedX : fixedX;
    const maxHeight = vertical > 0 ? 1 - fixedY : fixedY;
    const maxWidth = Math.max(minWidth, Math.min(maxWidthX, maxHeight / heightPerWidth, 1));
    let latest: LivePlacement = { ...origin, snapX: false, snapY: false };
    setActive(latest);
    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - startX) / rect.width;
      const dy = (moveEvent.clientY - startY) / rect.height;
      const widthFromX = origin.widthShare + horizontal * dx;
      const widthFromY = (origin.heightShare + vertical * dy) / heightPerWidth;
      const candidate = Math.abs(widthFromX - origin.widthShare) >= Math.abs(widthFromY - origin.widthShare)
        ? widthFromX : widthFromY;
      const widthShare = clamp(candidate, minWidth, maxWidth);
      const heightShare = widthShare * heightPerWidth;
      latest = {
        x: fixedX + horizontal * widthShare / 2,
        y: fixedY + vertical * heightShare / 2,
        widthShare,
        heightShare,
        angle: origin.angle,
        snapX: false,
        snapY: false,
      };
      setLive(latest);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
    };
    const finish = () => { cleanup(); onChange(latest); setActive(null); };
    const cancel = () => { cleanup(); setActive(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  };

  return <div ref={stageRef} className={`placement-stage ${className}`.trim()} style={style}>
    <img src={pageImage} alt={imageAlt} draggable={false} />
    {current.snapX && <span className="placement-guide placement-guide-v watermark-guide watermark-guide-v" aria-hidden="true" />}
    {current.snapY && <span className="placement-guide placement-guide-h watermark-guide watermark-guide-h" aria-hidden="true" />}
    <div
      className={`placement-handle ${handleClassName}${active ? ' is-dragging' : ''}`.trim()}
      style={{
        left: `${current.x * 100}%`,
        top: `${current.y * 100}%`,
        width: `${current.widthShare * 100}%`,
        height: `${current.heightShare * 100}%`,
        transform: `translate(-50%, -50%) rotate(${current.angle ?? 0}deg)`,
      }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      title={title}
      onPointerDown={beginMove}
      onKeyDown={nudge}
    >
      {typeof children === 'function' ? children(current, active, stageSize.width) : children}
      {resizable && (['nw', 'ne', 'sw', 'se'] as const).map((corner) => <span
        key={corner}
        role="slider"
        aria-label={`Resize from ${corner}`}
        className={`placement-resize-handle placement-resize-${corner}`}
        onPointerDown={(event) => beginResize(corner, event)}
      />)}
    </div>
  </div>;
}
