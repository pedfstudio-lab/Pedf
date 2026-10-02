import { buildBulletListEdits, buildTextBlockEdits } from '@/lib/edit/buildTextEdits';
import type { PagePreviewSelection } from '@/lib/export/exportPagePreview';
import type { CoverEdit, TextEdit } from '@/lib/export/types';
import type { BulletList } from './bulletList';
import type { TextBlock } from './textContent';

/** Transient removal only: never builds a replacement or changes the edit store. */
export function textPreviewSelection(
  block: TextBlock,
  existing?: { readonly covers: readonly CoverEdit[]; readonly texts: readonly TextEdit[] },
  list?: BulletList,
  extendCover: (cover: CoverEdit, fontSize: number) => CoverEdit = (cover) => cover,
): PagePreviewSelection {
  const key = `${block.pageIndex}:${block.rect.x}:${block.rect.y}:${block.text}`;
  const next = { text: block.text, style: block.style, width: block.rect.w, height: block.rect.h, dx: 0, dy: 0 };
  const covers = existing?.covers ?? (list
    ? buildBulletListEdits(list, next, [], 0, Number.POSITIVE_INFINITY).covers
    : buildTextBlockEdits(block, next, [], 0).covers);
  const transientEdits = existing ? [] : covers.map((cover, index) => extendCover(
    { ...cover, id: `preview-${key}-${index}` },
    list?.block.style.fontSizePt ?? block.lines[index]?.style.fontSizePt ?? block.style.fontSizePt,
  ));
  const sourceStyles = [block.style, ...block.lines.flatMap((line) => [line.style, ...line.runs.map((run) => run.style)])];
  return {
    key, transientEdits,
    omitTextIds: existing?.texts.map((edit) => edit.id) ?? [],
    coverIds: (existing?.covers ?? transientEdits).map((cover) => cover.id),
    paintSupported: sourceStyles.every((style) => style.colorKnown !== false),
    ...(list?.items.some((item) => !item.markerRun && !item.markerImage)
      ? { unsafeReason: 'This list uses vector markers that the text-removal path cannot remove.' } : {}),
  };
}
