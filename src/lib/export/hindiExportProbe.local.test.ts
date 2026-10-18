import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { exportPdf } from './exportPdf';
import type { EditDocument, TextEdit } from './types';

describe.runIf(process.env.HINDI_EXPORT_PROBE === '1' || process.env.TASK79_REAL === '1')('Task 79 real saved-project Indian-script export', () => {
  it('exports an edit containing Hindi', { timeout: 120_000 }, async () => {
    const bytes = new Uint8Array(await readFile('tmp/bullets/RAHUL_RAJPUT_RESUME.pdf'));
    const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    const pages: EditDocument['pages'] = [];
    for (let index = 0; index < document.numPages; index++) {
      const page = await document.getPage(index + 1), [x = 0, y = 0, right = 0, top = 0] = page.view;
      pages.push({ pageIndex: index, widthPt: right - x, heightPt: top - y, rotation: 0, boxOffset: { x, y } });
    }
    await document.destroy();
    const style = { fontName: 'Helvetica', fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
    for (const text of ['Hello', 'Hello नमस्ते']) {
      const edit: TextEdit = { id: `t-${text}`, kind: 'text', pageIndex: 0, rect: { x: 100, y: 400, w: 200, h: 12 }, z: 1, text, style };
      const result = await exportPdf({ originalBytes: bytes, pages, edits: [edit] });
      const reader = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
      try {
        const page = await reader.getPage(1), content = await page.getTextContent();
        const saved = content.items.map(item => 'str' in item ? item.str : '').join(' ');
        expect(saved).toContain('Hello'); expect(saved).not.toContain('नमस्ते');
        expect(result.warnings.some(warning => warning.includes('Indian-script text') && warning.includes('page 1'))).toBe(text.includes('नमस्ते'));
      } finally { await reader.destroy(); }
    }
  });
});
