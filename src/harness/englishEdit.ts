import { loadDocument } from '@/lib/pdf/loadDocument';
import type { CoverEdit, TextEdit } from '@/lib/export/types';
import type { Scenario } from './runScenario';

export const englishEditScenario: Scenario = {
  name: 'English text edit (unedited pages stable)',
  tolerance: 0.001,
  comparePageIndexes: [1, 2, 3, 4, 5],
  async setup() {
    const response = await fetch(`${import.meta.env.BASE_URL}samples/sample-basic.pdf`);
    if (!response.ok) throw new Error(`sample PDF request failed: HTTP ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const loaded = await loadDocument(bytes);
    await loaded.doc.destroy();

    const rect = { x: 42, y: 728, w: 180, h: 18 };
    const cover: CoverEdit = {
      id: 'harness-english-cover',
      kind: 'cover',
      pageIndex: 0,
      rect,
      z: 1,
      sampleBackground: true,
    };
    const text: TextEdit = {
      id: 'harness-english-text',
      kind: 'text',
      pageIndex: 0,
      rect,
      z: 2,
      text: 'Edited in DesiPDF',
      style: {
        fontName: 'Helvetica',
        fontSizePt: 14,
        bold: true,
        italic: false,
        color: { r: 0.05, g: 0.15, b: 0.35 },
      },
    };

    return {
      doc: {
        originalBytes: loaded.originalBytes,
        edits: [cover, text],
        pages: loaded.pages,
        sampleBackground: () => ({ r: 1, g: 1, b: 1 }),
      },
      expectedBytes: loaded.originalBytes.slice(),
    };
  },
};
