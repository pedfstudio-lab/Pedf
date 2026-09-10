// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { Edit, ImageEdit } from '@/lib/export/types';

const harness = vi.hoisted(() => ({
  edits: [] as Edit[],
  originalBytes: new Uint8Array(),
  addEdits: vi.fn(),
  removeEdit: vi.fn(),
  replaceEdits: vi.fn(),
  updateEdit: vi.fn(),
  detect: vi.fn(),
  extract: vi.fn(),
  capture: vi.fn(),
  getPageCanvas: vi.fn(),
  sampleDelete: vi.fn(),
}));

vi.mock('@/state/editsStore', () => ({
  useEdits: () => ({
    edits: harness.edits,
    addEdits: harness.addEdits,
    removeEdit: harness.removeEdit,
    replaceEdits: harness.replaceEdits,
    updateEdit: harness.updateEdit,
  }),
}));

vi.mock('@/state/documentStore', () => ({
  useDocumentStore: () => ({
    document: { loaded: { originalBytes: harness.originalBytes } },
    getPageCanvas: harness.getPageCanvas,
  }),
}));

vi.mock('@/lib/pdf/images', () => ({
  detectImageCandidates: harness.detect,
}));

vi.mock('@/lib/images/extractImage', () => ({
  extractImageBytes: harness.extract,
}));

vi.mock('@/lib/images/imageCrop', () => ({
  capturePdfRegion: harness.capture,
  cropImageBytes: vi.fn(),
}));

vi.mock('@/lib/images/imageRichness', () => ({
  isRasterTextRegion: () => false,
  sampleImageRichness: () => undefined,
  shouldKeepImageRegion: () => true,
}));

vi.mock('@/lib/images/outsideBackground', () => ({
  sampleDeleteImageCover: harness.sampleDelete,
  sampleOutsideImage: () => ({ r: 1, g: 1, b: 1 }),
}));

import { ImageOverlay } from './ImageOverlay';

const PNG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3);
const REGION = { pageIndex: 0, rect: { x: 20, y: 40, w: 80, h: 40 } };

const viewport = {
  width: 300,
  height: 400,
  scale: 1,
  transform: [1, 0, 0, -1, 0, 400],
  viewBox: [0, 0, 300, 400],
  convertToPdfPoint: (x: number, y: number) => [x, 400 - y],
  convertToViewportPoint: (x: number, y: number) => [x, 400 - y],
} as unknown as PageViewport;

const page = {
  getViewport: () => viewport,
} as unknown as PDFPageProxy;

function renderOverlay({ imageMode = true, directMode = false } = {}) {
  return render(
    <ImageOverlay
      page={page}
      pageIndex={0}
      viewport={viewport}
      dpr={1}
      imageMode={imageMode}
      directMode={directMode}
    />,
  );
}

beforeAll(async () => {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage([300, 400]);
  harness.originalBytes = new Uint8Array((await pdf.save()).slice().buffer as ArrayBuffer);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:image'),
    revokeObjectURL: vi.fn(),
  });
});

beforeEach(() => {
  harness.edits = [];
  harness.addEdits.mockReset();
  harness.removeEdit.mockReset();
  harness.replaceEdits.mockReset();
  harness.updateEdit.mockReset();
  harness.detect.mockReset().mockResolvedValue([{
    region: REGION,
    hasText: false,
    paragraph: false,
  }]);
  harness.extract.mockReset().mockReturnValue({ bytes: PNG, mime: 'image/png' });
  harness.capture.mockReset();
  harness.getPageCanvas.mockReset().mockReturnValue(undefined);
  harness.sampleDelete.mockReset().mockReturnValue(undefined);
});

afterEach(cleanup);

describe('ImageOverlay move and resize', () => {
  it('commits an existing image as one cover at the old rect and one image at the new rect', async () => {
    renderOverlay();
    fireEvent.click(await screen.findByRole('button', { name: /Move or resize image 1/ }));
    const move = await screen.findByRole('button', { name: 'Move selected image' });
    fireEvent.pointerDown(move, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 70 });
    fireEvent.pointerUp(window);
    expect(harness.addEdits).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(harness.addEdits).toHaveBeenCalledTimes(1);
    const [cover, image] = harness.addEdits.mock.calls[0]![0] as Edit[];
    expect(cover).toMatchObject({ kind: 'cover', rect: REGION.rect });
    expect(cover?.id).toMatch(/^image-move-cover-/);
    expect(image).toMatchObject({ kind: 'image', bytes: PNG });
    expect(image?.rect).not.toEqual(REGION.rect);
    expect(harness.updateEdit).not.toHaveBeenCalled();
  });

  it('updates a placed image only and keeps its aspect ratio while resizing', async () => {
    const edit: ImageEdit = {
      id: 'placed-image',
      kind: 'image',
      pageIndex: 0,
      rect: REGION.rect,
      z: 2,
      bytes: PNG,
    };
    harness.edits = [edit];
    harness.detect.mockResolvedValue([]);
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: /Move or resize added image 1/ }));
    const handle = screen.getByRole('button', { name: /Resize selected image from se corner/ });
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 120 });
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(harness.updateEdit).toHaveBeenCalledTimes(1);
    const updated = harness.updateEdit.mock.calls[0]![0] as ImageEdit;
    expect(updated.id).toBe(edit.id);
    expect(updated.rect.w / updated.rect.h).toBeCloseTo(2);
    expect(harness.addEdits).not.toHaveBeenCalled();
  });

  it('links the millimetre fields and Cancel leaves edits untouched', async () => {
    const edit: ImageEdit = {
      id: 'placed-image',
      kind: 'image',
      pageIndex: 0,
      rect: REGION.rect,
      z: 2,
      bytes: PNG,
    };
    harness.edits = [edit];
    harness.detect.mockResolvedValue([]);
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: /Move or resize added image 1/ }));
    const width = screen.getByRole('spinbutton', { name: 'Image width in millimetres' });
    const height = screen.getByRole('spinbutton', { name: 'Image height in millimetres' });
    fireEvent.change(width, {
      target: { value: '50' },
    });
    expect((height as HTMLInputElement).value).toBe('14.1');
    fireEvent.keyDown(width, { key: 'Enter' });
    expect((width as HTMLInputElement).value).toBe('50.0');
    expect((height as HTMLInputElement).value).toBe('25.0');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(harness.updateEdit).not.toHaveBeenCalled();
    expect(harness.addEdits).not.toHaveBeenCalled();
  });

  it('keeps an exact-size draft untouched until Enter commits it', async () => {
    const edit: ImageEdit = {
      id: 'placed-image',
      kind: 'image',
      pageIndex: 0,
      rect: REGION.rect,
      z: 2,
      bytes: PNG,
    };
    harness.edits = [edit];
    harness.detect.mockResolvedValue([]);
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: /Move or resize added image 1/ }));
    const width = screen.getByRole('spinbutton', { name: 'Image width in millimetres' });
    const height = screen.getByRole('spinbutton', { name: 'Image height in millimetres' });

    fireEvent.change(width, { target: { value: '6' } });
    expect((width as HTMLInputElement).value).toBe('6');
    expect((height as HTMLInputElement).value).toBe('14.1');
    fireEvent.change(width, { target: { value: '60' } });
    expect((width as HTMLInputElement).value).toBe('60');
    expect((height as HTMLInputElement).value).toBe('14.1');
    fireEvent.keyDown(width, { key: 'Enter' });
    expect((width as HTMLInputElement).value).toBe('60.0');
    expect((height as HTMLInputElement).value).toBe('30.0');
  });

  it('commits exact size on blur and Escape discards only the field draft', async () => {
    const edit: ImageEdit = {
      id: 'placed-image',
      kind: 'image',
      pageIndex: 0,
      rect: REGION.rect,
      z: 2,
      bytes: PNG,
    };
    harness.edits = [edit];
    harness.detect.mockResolvedValue([]);
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: /Move or resize added image 1/ }));
    const width = screen.getByRole('spinbutton', { name: 'Image width in millimetres' });
    const height = screen.getByRole('spinbutton', { name: 'Image height in millimetres' });

    fireEvent.change(height, { target: { value: '20' } });
    fireEvent.blur(height);
    expect((height as HTMLInputElement).value).toBe('20.0');
    expect((width as HTMLInputElement).value).toBe('40.0');
    fireEvent.change(width, { target: { value: '70' } });
    fireEvent.keyDown(width, { key: 'Escape' });
    expect((width as HTMLInputElement).value).toBe('40.0');
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('nudges a selected image by 1 point, or 10 points with Shift', async () => {
    const edit: ImageEdit = {
      id: 'placed-image',
      kind: 'image',
      pageIndex: 0,
      rect: REGION.rect,
      z: 2,
      bytes: PNG,
    };
    harness.edits = [edit];
    harness.detect.mockResolvedValue([]);
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: /Move or resize added image 1/ }));
    const selection = screen.getByLabelText(/Selected image\. Drag to move/);
    fireEvent.keyDown(selection, { key: 'ArrowRight' });
    fireEvent.keyDown(selection, { key: 'ArrowUp', shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    const updated = harness.updateEdit.mock.calls[0]![0] as ImageEdit;
    expect(updated.rect.x).toBeCloseTo(REGION.rect.x + 1);
    expect(updated.rect.y).toBeCloseTo(REGION.rect.y + 10);
  });

  it('warns when an existing image must use the 2x rendered fallback', async () => {
    harness.extract.mockReturnValue(undefined);
    harness.capture.mockResolvedValue(PNG);
    renderOverlay();
    fireEvent.click(await screen.findByRole('button', { name: /Move or resize image 1/ }));

    expect((await screen.findByRole('status')).textContent).toContain(
      'Moved image was re-rendered; it may be slightly softer.',
    );
    expect(harness.capture).toHaveBeenCalledWith(page, REGION.rect, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(harness.addEdits).toHaveBeenCalledTimes(1);
  });

  it('uses the Delete colour sampler for the old spot of a moved existing image', async () => {
    const canvas = document.createElement('canvas');
    harness.getPageCanvas.mockReturnValue({ canvas, viewport, dpr: 1 });
    harness.sampleDelete.mockReturnValue({
      color: { r: 0.5, g: 0.5, b: 0.5 },
      rect: REGION.rect,
    });
    renderOverlay();
    fireEvent.click(await screen.findByRole('button', { name: /Move or resize image 1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));

    expect(harness.sampleDelete).toHaveBeenCalledWith(
      canvas,
      viewport,
      REGION.rect,
      expect.any(Object),
    );
    const [cover] = harness.addEdits.mock.calls[0]![0] as Edit[];
    expect(cover).toMatchObject({
      kind: 'cover',
      color: { r: 0.5, g: 0.5, b: 0.5 },
    });
  });

  it('does nothing and explains when extraction and the canvas fallback both fail', async () => {
    harness.extract.mockReturnValue(undefined);
    harness.capture.mockRejectedValue(new Error('canvas unavailable'));
    renderOverlay();
    fireEvent.click(await screen.findByRole('button', { name: /Move or resize image 1/ }));
    expect((await screen.findByRole('alert')).textContent).toContain(CANNOT_MOVE_TEXT);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Done' })).toBeNull());
    expect(harness.addEdits).not.toHaveBeenCalled();
  });
});

describe('ImageOverlay direct image interaction', () => {
  it('shows plain hit areas, excludes full-page backgrounds, and keeps placed images selectable', async () => {
    const fullPage = { pageIndex: 0, rect: { x: 0, y: 0, w: 300, h: 400 } };
    harness.detect.mockResolvedValue([
      { region: REGION, hasText: false, paragraph: false },
      { region: fullPage, hasText: false, paragraph: false },
    ]);
    harness.edits = [{
      id: 'placed-background',
      kind: 'image',
      pageIndex: 0,
      rect: fullPage.rect,
      z: 2,
      bytes: PNG,
    }];
    renderOverlay({ imageMode: false, directMode: true });

    expect(await screen.findByRole('button', { name: 'Move or resize image 1 on page 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move or resize added image 1 on page 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move or resize image 2 on page 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Crop/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.queryByLabelText('Draw image region on page 1')).toBeNull();
    expect(screen.queryByText(/Drag to add/)).toBeNull();
  });

  it('moves an existing image during one mouse gesture and waits for Done to commit', async () => {
    renderOverlay({ imageMode: false, directMode: true });
    const hitArea = await screen.findByRole('button', { name: 'Move or resize image 1 on page 1' });
    fireEvent.pointerDown(hitArea, {
      button: 0,
      pointerId: 10,
      pointerType: 'mouse',
      clientX: 50,
      clientY: 50,
    });
    fireEvent.pointerMove(window, { pointerId: 10, clientX: 80, clientY: 70 });
    fireEvent.pointerUp(window, { pointerId: 10, clientX: 80, clientY: 70 });

    await screen.findByLabelText(/Selected image\. Drag to move/);
    expect(harness.addEdits).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const [cover, image] = harness.addEdits.mock.calls[0]![0] as Edit[];
    expect(cover).toMatchObject({ kind: 'cover', rect: REGION.rect });
    expect(image).toMatchObject({ kind: 'image' });
    if (image?.kind !== 'image') throw new Error('Expected moved image edit.');
    expect(image.rect.x).toBeCloseTo(REGION.rect.x + 30);
    expect(image.rect.y).toBeCloseTo(REGION.rect.y - 20);
  });

  it('treats a press and release without movement as selection only', async () => {
    renderOverlay({ imageMode: false, directMode: true });
    const hitArea = await screen.findByRole('button', { name: 'Move or resize image 1 on page 1' });
    fireEvent.pointerDown(hitArea, {
      button: 0,
      pointerId: 11,
      pointerType: 'mouse',
      clientX: 50,
      clientY: 50,
    });
    fireEvent.pointerUp(window, { pointerId: 11, clientX: 50, clientY: 50 });

    const selection = await screen.findByLabelText(/Selected image\. Drag to move/);
    expect(selection.style.left).toBe('20px');
    expect(selection.style.top).toBe('320px');
    expect(harness.addEdits).not.toHaveBeenCalled();
  });

  it('does not move until the mouse crosses the drag threshold', async () => {
    renderOverlay({ imageMode: false, directMode: true });
    const hitArea = await screen.findByRole('button', { name: 'Move or resize image 1 on page 1' });
    fireEvent.pointerDown(hitArea, {
      button: 0,
      pointerId: 12,
      pointerType: 'mouse',
      clientX: 50,
      clientY: 50,
    });
    fireEvent.pointerMove(window, { pointerId: 12, clientX: 53, clientY: 50 });
    fireEvent.pointerUp(window, { pointerId: 12, clientX: 53, clientY: 50 });

    const selection = await screen.findByLabelText(/Selected image\. Drag to move/);
    expect(selection.style.left).toBe('20px');
    expect(selection.style.top).toBe('320px');
  });

  it('selects on touch without turning the initial gesture into a drag', async () => {
    renderOverlay({ imageMode: false, directMode: true });
    const hitArea = await screen.findByRole('button', { name: 'Move or resize image 1 on page 1' });
    fireEvent.pointerDown(hitArea, {
      button: 0,
      pointerId: 13,
      pointerType: 'touch',
      clientX: 50,
      clientY: 50,
    });
    fireEvent.pointerMove(window, { pointerId: 13, clientX: 80, clientY: 50 });
    fireEvent.pointerUp(window, { pointerId: 13, clientX: 80, clientY: 50 });

    const selection = await screen.findByLabelText(/Selected image\. Drag to move/);
    expect(selection.style.left).toBe('20px');
    expect(selection.style.top).toBe('320px');
  });

  it('cancels a direct selection when the user presses elsewhere', async () => {
    renderOverlay({ imageMode: false, directMode: true });
    const hitArea = await screen.findByRole('button', { name: 'Move or resize image 1 on page 1' });
    fireEvent.pointerDown(hitArea, {
      button: 0,
      pointerId: 14,
      pointerType: 'mouse',
      clientX: 50,
      clientY: 50,
    });
    fireEvent.pointerUp(window, { pointerId: 14, clientX: 50, clientY: 50 });
    await screen.findByRole('button', { name: 'Done' });
    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' });

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Done' })).toBeNull());
    expect(harness.addEdits).not.toHaveBeenCalled();
    expect(harness.updateEdit).not.toHaveBeenCalled();
  });

  it('applies a pending drag when existing-image bytes arrive after the pointer moved', async () => {
    let resolveCapture!: (bytes: Uint8Array) => void;
    const capture = new Promise<Uint8Array>((resolve) => { resolveCapture = resolve; });
    harness.extract.mockReturnValue(undefined);
    harness.capture.mockReturnValue(capture);
    renderOverlay({ imageMode: false, directMode: true });
    const hitArea = await screen.findByRole('button', { name: 'Move or resize image 1 on page 1' });
    fireEvent.pointerDown(hitArea, {
      button: 0,
      pointerId: 15,
      pointerType: 'mouse',
      clientX: 50,
      clientY: 50,
    });
    fireEvent.pointerMove(window, { pointerId: 15, clientX: 90, clientY: 50 });
    fireEvent.pointerUp(window, { pointerId: 15, clientX: 90, clientY: 50 });
    await waitFor(() => expect(harness.capture).toHaveBeenCalled());
    await act(async () => { resolveCapture(PNG); });

    const selection = await screen.findByLabelText(/Selected image\. Drag to move/);
    await waitFor(() => expect(selection.style.left).toBe('60px'));
    expect(selection.style.top).toBe('320px');
  });

  it('renders no image hit areas when both editor image modes are off', async () => {
    renderOverlay({ imageMode: false, directMode: false });
    await waitFor(() => expect(harness.detect).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Move or resize image/ })).toBeNull();
  });
});

const CANNOT_MOVE_TEXT = "This image can't be moved";
