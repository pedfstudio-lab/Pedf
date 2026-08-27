import { describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { exportPdf } from './exportPdf';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { planToGeometry } from '@/state/pagePlan';
import type { PagePlan } from '@/state/pagePlan';
import type { CoverEdit, EditDocument, LineEdit, PdfRect, TextEdit } from './types';

async function makeTwoPageDocument(): Promise<EditDocument> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const firstPage = pdf.addPage([300, 400]);
  const secondPage = pdf.addPage([500, 600]);
  secondPage.setRotation(degrees(90));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  firstPage.drawText('First source marker', { x: 20, y: 350, size: 12, font });
  secondPage.drawText('Second source marker', { x: 20, y: 550, size: 12, font });

  return {
    originalBytes: await pdf.save(),
    edits: [],
    pages: [
      {
        pageIndex: 0,
        widthPt: 300,
        heightPt: 400,
        rotation: 0,
        boxOffset: { x: 0, y: 0 },
      },
      {
        pageIndex: 1,
        widthPt: 500,
        heightPt: 600,
        rotation: 90,
        boxOffset: { x: 0, y: 0 },
      },
    ],
  };
}

describe('exportPdf', () => {
  it('round-trips a zero-edit document as valid PDF bytes without changing page structure', async () => {
    const doc = await makeTwoPageDocument();
    doc.plan = [
      { id: 'source-0', kind: 'source', sourceIndex: 0 },
      { id: 'source-1', kind: 'source', sourceIndex: 1 },
    ];
    const pristineSnapshot = doc.originalBytes.slice();

    const result = await exportPdf(doc);

    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe('%PDF-');
    expect(result.warnings).toEqual([]);
    expect(doc.originalBytes).toEqual(pristineSnapshot);

    const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(reopened.getPageCount()).toBe(2);
    expect(reopened.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
    expect(reopened.getPage(1).getSize()).toEqual({ width: 500, height: 600 });
    expect(reopened.getPage(1).getRotation().angle).toBe(90);
  });

  it('duplicates source content in plan order and stamps an edit onto the copy', async () => {
    const doc = await makeTwoPageDocument();
    const plan: PagePlan = [
      { id: 'source-0', kind: 'source', sourceIndex: 0 },
      { id: 'source-1', kind: 'source', sourceIndex: 1 },
      { id: 'source-1-copy', kind: 'source', sourceIndex: 1 },
    ];
    doc.plan = plan;
    doc.pages = planToGeometry(plan, doc.pages);
    doc.edits = [{
      id: 'copy-text',
      kind: 'text',
      pageIndex: 2,
      rect: { x: 20, y: 510, w: 200, h: 18 },
      z: 1,
      text: 'Edit on duplicate',
      origin: 'free',
      style: {
        fontName: 'Helvetica',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
    }];

    const result = await exportPdf(doc);
    const reopened = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
    try {
      expect(reopened.numPages).toBe(3);
      const secondText = await (await reopened.getPage(2)).getTextContent();
      const copyText = await (await reopened.getPage(3)).getTextContent();
      const extract = (items: typeof secondText.items) => items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map((item) => item.str)
        .join(' ');
      expect(extract(secondText.items)).toContain('Second source marker');
      expect(extract(copyText.items)).toContain('Second source marker');
      expect(extract(copyText.items)).toContain('Edit on duplicate');
    } finally {
      await reopened.destroy();
    }
  });

  it('inserts a same-size blank page and stamps its edit at the new position', async () => {
    const doc = await makeTwoPageDocument();
    const plan: PagePlan = [
      { id: 'source-0', kind: 'source', sourceIndex: 0 },
      { id: 'blank', kind: 'blank', widthPt: 300, heightPt: 400 },
      { id: 'source-1', kind: 'source', sourceIndex: 1 },
    ];
    doc.plan = plan;
    doc.pages = planToGeometry(plan, doc.pages);
    doc.edits = [{
      id: 'blank-text',
      kind: 'text',
      pageIndex: 1,
      rect: { x: 20, y: 350, w: 200, h: 18 },
      z: 1,
      text: 'Text on inserted blank',
      origin: 'free',
      style: {
        fontName: 'Helvetica',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
    }];

    const result = await exportPdf(doc);
    const reopenedPdfLib = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(reopenedPdfLib.getPageCount()).toBe(3);
    expect(reopenedPdfLib.getPage(1).getSize()).toEqual({ width: 300, height: 400 });

    const reopened = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
    try {
      const blankContent = await (await reopened.getPage(2)).getTextContent();
      const text = blankContent.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map((item) => item.str)
        .join(' ');
      expect(text).toContain('Text on inserted blank');
    } finally {
      await reopened.destroy();
    }
  });

  it('exports a shorter plan without the deleted source page or its content', async () => {
    const doc = await makeTwoPageDocument();
    const originalPages = doc.pages;
    const plan: PagePlan = [{ id: 'source-1', kind: 'source', sourceIndex: 1 }];
    doc.plan = plan;
    doc.pages = planToGeometry(plan, originalPages);

    const result = await exportPdf(doc);
    const reopened = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
    try {
      expect(reopened.numPages).toBe(1);
      const content = await (await reopened.getPage(1)).getTextContent();
      const text = content.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map((item) => item.str)
        .join(' ');
      expect(text).toContain('Second source marker');
      expect(text).not.toContain('First source marker');
    } finally {
      await reopened.destroy();
    }
  });

  it('dispatches a sampled cover edit and keeps the exported document valid', async () => {
    const doc = await makeTwoPageDocument();
    const rect: PdfRect = { x: 40, y: 50, w: 120, h: 36 };
    const cover: CoverEdit = {
      id: 'cover-1',
      kind: 'cover',
      pageIndex: 1,
      rect,
      z: 10,
      sampleBackground: true,
    };
    const sampleBackground = vi.fn(() => ({ r: 0.9, g: 0.8, b: 0.7 }));
    doc.edits = [cover];
    doc.sampleBackground = sampleBackground;

    const result = await exportPdf(doc);

    expect(sampleBackground).toHaveBeenCalledOnce();
    expect(sampleBackground).toHaveBeenCalledWith(1, rect);
    expect(result.warnings).toEqual([]);

    const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(reopened.getPageCount()).toBe(2);
    expect(reopened.getPage(1).getRotation().angle).toBe(90);
  });

  it('writes cover-free English text as selectable content that reopens cleanly in PDF.js', async () => {
    const doc = await makeTwoPageDocument();
    const text: TextEdit = {
      id: 'text-1',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 20, y: 300, w: 180, h: 18 },
      z: 20,
      text: 'Free text in DesiPDF',
      origin: 'free',
      boxId: 'free-box-1',
      style: {
        fontName: 'Helvetica',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
    };
    doc.edits = [text];

    const result = await exportPdf(doc);
    const reopened = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
    try {
      expect(reopened.numPages).toBe(2);
      const content = await (await reopened.getPage(1)).getTextContent();
      const extracted = content.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map((item) => item.str)
        .join(' ');
      expect(extracted).toContain('Free text in DesiPDF');
    } finally {
      await reopened.destroy();
    }
  });

  it('writes mixed English spans as selectable text that reopens cleanly', async () => {
    const doc = await makeTwoPageDocument();
    doc.edits = [{
      id: 'rich-text-1',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 20, y: 260, w: 220, h: 18 },
      z: 20,
      text: 'Plain bold italic',
      spans: [
        { text: 'Plain ', bold: false, italic: false },
        { text: 'bold ', bold: true, italic: false },
        { text: 'italic', bold: false, italic: true },
      ],
      style: {
        fontName: 'Helvetica',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
    }];

    const result = await exportPdf(doc);
    const reopened = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
    try {
      const content = await (await reopened.getPage(1)).getTextContent();
      const extracted = content.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map((item) => item.str)
        .join('');
      expect(extracted).toContain('Plain bold italic');
    } finally {
      await reopened.destroy();
    }
  });

  it('writes a native divider line that reopens at the edited position', async () => {
    const doc = await makeTwoPageDocument();
    const line: LineEdit = {
      id: 'line-1',
      kind: 'line',
      pageIndex: 0,
      rect: { x: 20, y: 249.5, w: 260, h: 1 },
      z: 20,
      x1: 20,
      y1: 250,
      x2: 280,
      y2: 250,
      thicknessPt: 1,
      color: { r: 0.2, g: 0.3, b: 0.4 },
    };
    doc.edits = [line];

    const result = await exportPdf(doc);
    const reopened = await getDocument({ data: result.bytes.slice(), verbosity: 0 }).promise;
    try {
      const detected = await detectRuleLines(await reopened.getPage(1), 0);
      expect(detected).toEqual([
        expect.objectContaining({
          orientation: 'horizontal',
          x1: 20,
          y1: 250,
          x2: 280,
          y2: 250,
          thicknessPt: 1,
        }),
      ]);
    } finally {
      await reopened.destroy();
    }
  });

  it('still rejects Indic text at the guarded Task 13 boundary', async () => {
    const doc = await makeTwoPageDocument();
    doc.edits = [{
      id: 'indic-text-1',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 20, y: 300, w: 180, h: 18 },
      z: 20,
      text: 'हिन्दी',
      style: {
        fontName: 'Helvetica',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
    }];

    await expect(exportPdf(doc)).rejects.toThrow(/Not implemented yet: Indic text export/);
  });
});
