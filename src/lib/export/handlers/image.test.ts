import { describe, expect, it, vi } from 'vitest';
import type { PageExportContext } from '../context';
import type { ImageEdit } from '../types';
import { drawImage } from './image';

function edit(bytes: Uint8Array): ImageEdit {
  return {
    id: 'image-test',
    kind: 'image',
    pageIndex: 0,
    rect: { x: 12, y: 34, w: 56, h: 78 },
    z: 1,
    bytes,
  };
}

describe('drawImage', () => {
  it('embeds PNG bytes and draws the supplied PDF rectangle exactly', async () => {
    const embedded = { width: 1, height: 1 };
    const embedPng = vi.fn(async () => embedded);
    const embedJpg = vi.fn();
    const draw = vi.fn();
    const context = {
      pdf: { embedPng, embedJpg },
      page: { drawImage: draw },
    } as unknown as PageExportContext;
    const input = edit(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    await drawImage(input, context);

    expect(embedPng).toHaveBeenCalledWith(input.bytes);
    expect(embedJpg).not.toHaveBeenCalled();
    expect(draw).toHaveBeenCalledWith(embedded, {
      x: 12,
      y: 34,
      width: 56,
      height: 78,
    });
  });

  it('routes JPEG bytes to embedJpg and rejects other encodings', async () => {
    const embedded = { width: 1, height: 1 };
    const context = {
      pdf: {
        embedPng: vi.fn(),
        embedJpg: vi.fn(async () => embedded),
      },
      page: { drawImage: vi.fn() },
    } as unknown as PageExportContext;

    await drawImage(edit(new Uint8Array([0xff, 0xd8, 0xff])), context);
    expect(context.pdf.embedJpg).toHaveBeenCalledOnce();
    await expect(drawImage(edit(new Uint8Array([0x47, 0x49, 0x46])), context))
      .rejects.toThrow(/PNG or JPEG/);
  });
});
