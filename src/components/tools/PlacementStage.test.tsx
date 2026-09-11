// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { PlacementStage, type PlacementValue } from './PlacementStage';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Harness({ changed }: { changed?: (value: PlacementValue) => void }) {
  const [value, setValue] = useState<PlacementValue>({ x: 0.5, y: 0.5, widthShare: 0.25, heightShare: 1 / 12 });
  return <PlacementStage pageImage="data:image/png;base64," imageAlt="Page" pageWidth={400} pageHeight={600}
    value={value} aspectRatio={2} resizable onChange={(next) => { setValue(next); changed?.(next); }}>
    <span>Signature</span>
  </PlacementStage>;
}

describe('PlacementStage', () => {
  it('passes its measured width to render-function children', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320);
    render(<PlacementStage pageImage="data:image/png;base64," imageAlt="Page" pageWidth={400} pageHeight={600}
      value={{ x: 0.5, y: 0.5, widthShare: 0.25, heightShare: 0.1 }} onChange={vi.fn()}>
      {(_placement, _active, stageWidthPx) => <span>{`Stage width ${stageWidthPx}`}</span>}
    </PlacementStage>);
    expect(await screen.findByText('Stage width 320')).toBeTruthy();
  });

  it('drags, snaps to centre guides, and nudges with the keyboard', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const changes: PlacementValue[] = [];
    render(<Harness changed={(value) => changes.push(value)} />);
    const handle = screen.getByRole('button', { name: /Move the item/ });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 203, clientY: 302 });
    expect(document.querySelector('.placement-guide-v')).toBeTruthy();
    expect(document.querySelector('.placement-guide-h')).toBeTruthy();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 180 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(changes.at(-1)).toMatchObject({ x: 0.75, y: 0.3 });
    fireEvent.keyDown(screen.getByRole('button', { name: /Move the item/ }), { key: 'ArrowLeft', shiftKey: true });
    expect(changes.at(-1)!.x).toBeCloseTo(0.7);
  });

  it('resizes from corners with a locked aspect ratio and a 40px minimum', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const changes: PlacementValue[] = [];
    render(<Harness changed={(value) => changes.push(value)} />);
    const corner = screen.getByRole('slider', { name: 'Resize from se' });
    fireEvent.pointerDown(corner, { button: 0, pointerId: 2, clientX: 250, clientY: 325 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 350, clientY: 325 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(changes.at(-1)!.widthShare).toBeCloseTo(0.5);
    expect(changes.at(-1)!.heightShare).toBeCloseTo(1 / 6);
    expect(changes.at(-1)!.x).toBeCloseTo(0.625);

    const resizedCorner = screen.getByRole('slider', { name: 'Resize from se' });
    fireEvent.pointerDown(resizedCorner, { button: 0, pointerId: 3, clientX: 350, clientY: 350 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: -1000, clientY: 350 });
    fireEvent.pointerUp(window, { pointerId: 3 });
    expect(changes.at(-1)!.widthShare).toBeCloseTo(0.1);
    expect(changes.at(-1)!.heightShare).toBeCloseTo(1 / 30);
  });
});
