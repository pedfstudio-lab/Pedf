import { describe, expect, it } from 'vitest';
import { editorSignatureEdit } from './editorSignature';

describe('editor signature integration', () => {
  it('creates exactly one ordinary centred ImageEdit at the top z-order', () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const result = editorSignatureEdit(
      { png: bytes, width: 400, height: 100 },
      2,
      { pageIndex: 2, widthPt: 600, heightPt: 800, rotation: 0, boxOffset: { x: 0, y: 0 } },
      [{ id: 'old', kind: 'image', pageIndex: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, z: 7, bytes }],
      'signature-test',
    );
    expect([result]).toHaveLength(1);
    expect(result).toEqual({
      id: 'signature-test', kind: 'image', pageIndex: 2, z: 8, bytes,
      rect: { x: 220, y: 380, w: 160, h: 40 },
    });
  });

  it('centres the edit inside a page whose visible box has a non-zero origin', () => {
    const result = editorSignatureEdit(
      { png: new Uint8Array([137, 80, 78, 71]), width: 400, height: 100 },
      0,
      { pageIndex: 0, widthPt: 600, heightPt: 800, rotation: 0, boxOffset: { x: 50, y: 30 } },
      [],
      'offset-signature',
    );
    expect(result.rect).toEqual({ x: 270, y: 410, w: 160, h: 40 });
  });
});
