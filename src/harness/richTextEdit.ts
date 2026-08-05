import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { TextEdit, TextSpan } from '@/lib/export/types';
import type { Scenario } from './runScenario';

const TEXT = 'The bold word stays selectable.';
const SPANS: readonly TextSpan[] = [
  { text: 'The ', bold: false, italic: false },
  { text: 'bold', bold: true, italic: false },
  { text: ' word stays selectable.', bold: false, italic: false },
];

export const richTextEditScenario: Scenario = {
  name: 'Rich text span edit',
  tolerance: 0.001,
  async setup() {
    const width = 320;
    const height = 180;
    const x = 30;
    const y = 110;
    const size = 14;
    const source = await PDFDocument.create({ updateMetadata: false });
    source.addPage([width, height]);
    const originalBytes = await source.save();

    const expected = await PDFDocument.load(originalBytes, { updateMetadata: false });
    const page = expected.getPage(0);
    const fonts = {
      regular: expected.embedStandardFont(StandardFonts.Helvetica),
      bold: expected.embedStandardFont(StandardFonts.HelveticaBold),
    };
    let cursorX = x;
    for (const span of SPANS) {
      const font = span.bold ? fonts.bold : fonts.regular;
      page.drawText(span.text, {
        x: cursorX,
        y,
        size,
        font,
        color: rgb(0.08, 0.12, 0.2),
      });
      cursorX += font.widthOfTextAtSize(span.text, size);
    }

    const edit: TextEdit = {
      id: 'harness-rich-text',
      kind: 'text',
      pageIndex: 0,
      rect: { x, y, w: 240, h: size },
      z: 1,
      text: TEXT,
      spans: SPANS,
      style: {
        fontName: 'Helvetica',
        fontSizePt: size,
        bold: false,
        italic: false,
        color: { r: 0.08, g: 0.12, b: 0.2 },
      },
    };

    return {
      doc: {
        originalBytes,
        edits: [edit],
        pages: [{
          pageIndex: 0,
          widthPt: width,
          heightPt: height,
          rotation: 0,
          boxOffset: { x: 0, y: 0 },
        }],
      },
      expectedBytes: await expected.save(),
    };
  },
};
