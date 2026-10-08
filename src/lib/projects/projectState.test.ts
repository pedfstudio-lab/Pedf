import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { exportPdf } from '@/lib/export/exportPdf';
import type { Edit, ImageEdit, TextEdit } from '@/lib/export/types';
import type { HistoryState } from '@/state/editsStore';
import { historyReducer } from '@/state/editsStore';
import type { PagePlan } from '@/state/pagePlan';
import {
  deserializeProject,
  hasDocumentChanges,
  SAVED_HISTORY_LIMIT,
  serializeProject,
} from './projectState';

const style = {
  fontName: 'Helvetica',
  fontSizePt: 12,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

const plan: PagePlan = [
  { id: 'source-0', kind: 'source', sourceIndex: 0 },
  { id: 'duplicate-0', kind: 'source', sourceIndex: 0 },
  { id: 'blank-0', kind: 'blank', widthPt: 300, heightPt: 400 },
  { id: 'source-2', kind: 'source', sourceIndex: 2 },
];

function allEditKinds(): Edit[] {
  const bullet: TextEdit = {
    id: 'bullet',
    kind: 'text',
    pageIndex: 0,
    rect: { x: 20, y: 300, w: 100, h: 12 },
    z: 2,
    text: '•',
    style,
    boxText: '• Saved bullet',
  };
  const image: ImageEdit = {
    id: 'image',
    kind: 'image',
    pageIndex: 1,
    rect: { x: 40, y: 200, w: 20, h: 20 },
    z: 3,
    bytes: new Uint8Array([1, 2, 3, 4]),
  };
  return [
    {
      id: 'text',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 30, y: 280, w: 120, h: 12 },
      z: 1,
      text: 'Saved text',
      style: { ...style, sourceBold: false, sourceStrokeBold: true, colorKnown: true },
      spans: [
        { text: 'Saved ', bold: false, italic: false },
        {
          text: 'text',
          bold: false,
          italic: false,
          color: { r: 0.8, g: 0.1, b: 0.2 },
          sourceBold: false,
          sourceStrokeBold: true,
          colorKnown: true,
        },
      ],
    },
    bullet,
    {
      id: 'cover',
      kind: 'cover',
      pageIndex: 0,
      rect: { x: 18, y: 270, w: 140, h: 45 },
      z: 0,
      sampleBackground: true,
      replaces: [{
        text: 'Original saved text',
        rect: { x: 30, y: 280, w: 120, h: 12 },
      }],
      replacesImages: [{
        kind: 'image',
        rect: { x: 18, y: 270, w: 140, h: 45 },
      }],
    },
    image,
    {
      id: 'line',
      kind: 'line',
      pageIndex: 3,
      rect: { x: 10, y: 100, w: 200, h: 1 },
      z: 4,
      x1: 10,
      y1: 100,
      x2: 210,
      y2: 100,
      thicknessPt: 1,
      color: { r: 0.1, g: 0.2, b: 0.3 },
    },
  ];
}

function history(edits = allEditKinds()): HistoryState {
  const present = { edits, plan };
  return {
    past: Array.from({ length: 35 }, (_, index) => ({
      edits: edits.slice(0, index % edits.length),
      plan,
    })),
    present,
    future: [{ edits: edits.slice(0, 2), plan }],
  };
}

describe('project state serialization', () => {
  it('round-trips and deep-clones paragraph spacing, retaining older saves without it', () => {
    const edit: TextEdit = { ...(allEditKinds()[0] as TextEdit), boxText: 'First\nSecond',
      boxParagraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }, { gapBeforePt: 3, firstIndentPt: 28.8, restIndentPt: 0 }] };
    const saved = serializeProject(history([edit]), 0, 1), restored = deserializeProject(saved, 3);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const copy = restored.value.history.present.edits[0] as TextEdit;
    expect(copy.boxParagraphs).toEqual(edit.boxParagraphs);
    expect(copy.boxParagraphs).not.toBe(edit.boxParagraphs);
    expect(copy.boxParagraphs?.[1]).not.toBe(edit.boxParagraphs?.[1]);
    for (const invalid of [-1, NaN, Infinity, '3']) {
      const corrupt = serializeProject(history([{ ...edit, boxParagraphs: [{ ...edit.boxParagraphs![0]!, gapBeforePt: invalid as number }, edit.boxParagraphs![1]!] }]), 0, 1);
      expect(deserializeProject(corrupt, 3)).toMatchObject({ ok: false, reason: 'corrupt' });
    }
    const old = { ...edit, boxParagraphs: undefined };
    expect(deserializeProject(serializeProject(history([old]), 0, 1), 3).ok).toBe(true);
  });
  it('opens a save whose paragraph layouts no longer match its text, dropping only those layouts', () => {
    // Saved before the placeholder-break fix: an empty paragraph added a
    // phantom line, so three text lines carry two layouts.
    const edit: TextEdit = { ...(allEditKinds()[0] as TextEdit), boxText: 'First\n\nSecond',
      boxParagraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }, { gapBeforePt: 3, firstIndentPt: 0, restIndentPt: 0 }] };
    const saved = serializeProject(history([edit]), 0, 1);
    expect((saved.history.present.edits[0] as TextEdit).boxParagraphs).toBeUndefined();
    const stored = { ...saved, history: { ...saved.history, present: { ...saved.history.present, edits: [edit] } } };
    const restored = deserializeProject(stored, 3);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const copy = restored.value.history.present.edits[0] as TextEdit;
    expect(copy.boxText).toBe('First\n\nSecond');
    expect(copy.text).toBe(edit.text);
    expect(copy.boxParagraphs).toBeUndefined();
  });
  it('round-trips all edit kinds, page operations, and capped undo history', () => {
    const source = history();
    const serialized = serializeProject(source, 2, 1.5);
    const restored = deserializeProject(serialized, 3);

    expect(serialized.history.past).toHaveLength(SAVED_HISTORY_LIMIT);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.lastPage).toBe(2);
    expect(restored.value.zoom).toBe(1.5);
    expect(restored.value.history.present.plan).toEqual(plan);
    expect(restored.value.history.present.edits).toEqual(allEditKinds());
    expect((restored.value.history.present.edits[3] as ImageEdit).bytes).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );

    const undone = historyReducer(restored.value.history, { type: 'undo' });
    expect(undone.future[0]).toEqual(restored.value.history.present);
    const redone = historyReducer(undone, { type: 'redo' });
    expect(redone.present).toEqual(restored.value.history.present);
  });

  it('returns clear errors for unsupported, corrupt, and impossible page data', () => {
    expect(deserializeProject({ formatVersion: 99 }, 3)).toMatchObject({
      ok: false,
      reason: 'unknown-version',
    });
    expect(deserializeProject({ formatVersion: 1, history: null }, 3)).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });
    const invalidTextField = serializeProject(history(), 0, 1) as unknown as {
      history: { present: { edits: Array<Record<string, unknown>> } };
    };
    invalidTextField.history.present.edits[0]!.align = 'diagonal';
    expect(deserializeProject(invalidTextField, 3)).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });
    const missingPage = serializeProject(history(), 0, 1);
    expect(deserializeProject(missingPage, 2)).toMatchObject({
      ok: false,
      reason: 'missing-source-page',
    });
  });

  it('deep-clones cover replacements and accepts older saves without them', () => {
    const source = history();
    const serialized = serializeProject(source, 0, 1);
    const sourceCover = source.present.edits.find((edit) => edit.kind === 'cover');
    const serializedCover = serialized.history.present.edits.find((edit) => edit.kind === 'cover');

    expect(serializedCover?.replaces).toEqual(sourceCover?.replaces);
    expect(serializedCover?.replaces).not.toBe(sourceCover?.replaces);
    expect(serializedCover?.replaces?.[0]?.rect).not.toBe(sourceCover?.replaces?.[0]?.rect);
    expect(serializedCover?.replacesImages).toEqual(sourceCover?.replacesImages);
    expect(serializedCover?.replacesImages).not.toBe(sourceCover?.replacesImages);
    expect(serializedCover?.replacesImages?.[0]?.rect).not.toBe(sourceCover?.replacesImages?.[0]?.rect);

    const legacy = serializeProject(source, 0, 1) as unknown as {
      history: { present: { edits: Array<Record<string, unknown>> } };
    };
    const legacyCover = legacy.history.present.edits.find((edit) => edit.kind === 'cover');
    delete legacyCover?.replaces;
    const legacyReplacement = Array.isArray(legacyCover?.replacesImages)
      ? legacyCover.replacesImages[0]
      : undefined;
    if (legacyReplacement && typeof legacyReplacement === 'object') {
      (legacyReplacement as Record<string, unknown>).objectId = 'img_p0_17';
    }
    const restoredLegacy = deserializeProject(legacy, 3);
    expect(restoredLegacy).toMatchObject({ ok: true });
    if (restoredLegacy.ok) {
      const restoredCover = restoredLegacy.value.history.present.edits.find((edit) => edit.kind === 'cover');
      expect(restoredCover && restoredCover.kind === 'cover'
        ? restoredCover.replacesImages?.[0]
        : undefined).toEqual({
        kind: 'image',
        rect: { x: 18, y: 270, w: 140, h: 45 },
      });
    }

    const olderWithoutImageClaims = serializeProject(source, 0, 1) as unknown as {
      history: { present: { edits: Array<Record<string, unknown>> } };
    };
    const olderCover = olderWithoutImageClaims.history.present.edits.find((edit) => edit.kind === 'cover');
    delete olderCover?.replacesImages;
    expect(deserializeProject(olderWithoutImageClaims, 3)).toMatchObject({ ok: true });
  });

  it('rejects corrupt replacement metadata', () => {
    const corrupt = serializeProject(history(), 0, 1) as unknown as {
      history: { present: { edits: Array<Record<string, unknown>> } };
    };
    const cover = corrupt.history.present.edits.find((edit) => edit.kind === 'cover');
    if (cover) cover.replaces = [{ text: 42, rect: { x: 1, y: 2, w: 3, h: 4 } }];

    expect(deserializeProject(corrupt, 3)).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });

    const corruptImage = serializeProject(history(), 0, 1) as unknown as {
      history: { present: { edits: Array<Record<string, unknown>> } };
    };
    const imageCover = corruptImage.history.present.edits.find((edit) => edit.kind === 'cover');
    if (imageCover) imageCover.replacesImages = [{ kind: 'photo', rect: { x: 1, y: 2, w: 3, h: 4 } }];
    expect(deserializeProject(corruptImage, 3)).toMatchObject({ ok: false, reason: 'corrupt' });
  });

  it('exports identically before saving and after restoring', async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const font = await source.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 3; index += 1) {
      source.addPage([300, 400]).drawText(`Source ${index + 1}`, { x: 20, y: 360, font, size: 12 });
    }
    const originalBytes = await source.save({ useObjectStreams: false });
    const edit: TextEdit = {
      id: 'saved-position',
      kind: 'text',
      pageIndex: 1,
      rect: { x: 55, y: 210, w: 130, h: 12 },
      z: 1,
      text: 'Restored position',
      style,
    };
    const sourceHistory: HistoryState = {
      past: [],
      present: { edits: [edit], plan },
      future: [],
    };
    const restored = deserializeProject(serializeProject(sourceHistory, 1, 1.25), 3);
    if (!restored.ok) throw new Error(restored.error);
    const pages = [
      { pageIndex: 0, widthPt: 300, heightPt: 400, rotation: 0 as const, boxOffset: { x: 0, y: 0 } },
      { pageIndex: 1, widthPt: 300, heightPt: 400, rotation: 0 as const, boxOffset: { x: 0, y: 0 } },
      { pageIndex: 2, widthPt: 300, heightPt: 400, rotation: 0 as const, boxOffset: { x: 0, y: 0 } },
      { pageIndex: 3, widthPt: 300, heightPt: 400, rotation: 0 as const, boxOffset: { x: 0, y: 0 } },
    ];
    const before = await exportPdf({
      originalBytes,
      edits: [edit],
      pages,
      plan,
    });
    const after = await exportPdf({
      originalBytes,
      edits: [...restored.value.history.present.edits],
      pages,
      plan: restored.value.history.present.plan,
    });

    const inspect = async (bytes: Uint8Array) => {
      const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
      try {
        const page = await document.getPage(2);
        const content = await page.getTextContent();
        const item = content.items.find((candidate) => (
          'str' in candidate && candidate.str === 'Restored position'
        ));
        return {
          pages: document.numPages,
          text: content.items.filter((candidate) => 'str' in candidate).map((candidate) => candidate.str),
          position: item && 'transform' in item ? [item.transform[4], item.transform[5]] : undefined,
        };
      } finally {
        await document.destroy();
      }
    };

    expect(await inspect(after.bytes)).toEqual(await inspect(before.bytes));
  });
});

describe('hasDocumentChanges', () => {
  const openingPlan: PagePlan = [
    { id: 'source-0', kind: 'source', sourceIndex: 0 },
    { id: 'source-1', kind: 'source', sourceIndex: 1 },
  ];
  const present = (nextPlan: PagePlan = openingPlan, edits: readonly Edit[] = []) => ({
    edits,
    plan: nextPlan,
  });

  it('treats a value-equal plan with no edits as unchanged', () => {
    expect(hasDocumentChanges(present(), openingPlan)).toBe(false);
    expect(hasDocumentChanges(
      present(openingPlan.map((entry) => ({ ...entry }))),
      openingPlan,
    )).toBe(false);
  });

  it('detects an edit and every kind of page-plan change', () => {
    expect(hasDocumentChanges(present(openingPlan, allEditKinds().slice(0, 1)), openingPlan)).toBe(true);
    expect(hasDocumentChanges(present(openingPlan.slice(0, 1)), openingPlan)).toBe(true);
    expect(hasDocumentChanges(present([
      ...openingPlan,
      { id: 'blank', kind: 'blank', widthPt: 612, heightPt: 792 },
    ]), openingPlan)).toBe(true);
    expect(hasDocumentChanges(present([
      openingPlan[0]!,
      { id: 'duplicate', kind: 'source', sourceIndex: 0 },
      openingPlan[1]!,
    ]), openingPlan)).toBe(true);
    expect(hasDocumentChanges(present([...openingPlan].reverse()), openingPlan)).toBe(true);
  });
});
