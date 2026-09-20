import type { Edit, PdfRect, ReplacedText, Rgb, TextSpan, TextStyle } from '@/lib/export/types';
import type { DocPresent, HistoryState } from '@/state/editsStore';
import type { PagePlan } from '@/state/pagePlan';

export const PROJECT_FORMAT_VERSION = 1;
export const SAVED_HISTORY_LIMIT = 30;

export interface SerializedProject {
  readonly formatVersion: typeof PROJECT_FORMAT_VERSION;
  readonly history: HistoryState;
  readonly lastPage: number;
  readonly zoom: number;
}

export interface RestoredProject {
  readonly history: HistoryState;
  readonly lastPage: number;
  readonly zoom: number;
}

export type DeserializeProjectResult =
  | { readonly ok: true; readonly value: RestoredProject }
  | {
      readonly ok: false;
      readonly reason: 'unknown-version' | 'corrupt' | 'missing-source-page';
      readonly error: string;
    };

function clonePlan(plan: PagePlan): PagePlan {
  return plan.map((entry) => ({ ...entry }));
}

function cloneEdit(edit: Edit): Edit {
  if (edit.kind === 'image') return { ...edit, rect: { ...edit.rect }, bytes: edit.bytes.slice() };
  if (edit.kind === 'text') {
    return {
      ...edit,
      rect: { ...edit.rect },
      style: { ...edit.style, color: { ...edit.style.color } },
      ...(edit.spans ? { spans: edit.spans.map((span) => ({ ...span })) } : {}),
      ...(edit.boxSpans ? { boxSpans: edit.boxSpans.map((span) => ({ ...span })) } : {}),
    };
  }
  return {
    ...edit,
    rect: { ...edit.rect },
    ...(edit.kind === 'line' ? { color: { ...edit.color } } : {}),
    ...(edit.kind === 'cover' && edit.color ? { color: { ...edit.color } } : {}),
    ...(edit.kind === 'cover' && edit.replaces ? {
      replaces: edit.replaces.map((replacement) => ({
        text: replacement.text,
        rect: { ...replacement.rect },
      })),
    } : {}),
  } as Edit;
}

function clonePresent(present: DocPresent): DocPresent {
  return {
    edits: present.edits.map(cloneEdit),
    plan: clonePlan(present.plan),
  };
}

function cloneHistory(history: HistoryState): HistoryState {
  return {
    past: history.past.map(clonePresent),
    present: clonePresent(history.present),
    future: history.future.map(clonePresent),
  };
}

function plansEqual(left: PagePlan, right: PagePlan): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    if (!other || entry.id !== other.id || entry.kind !== other.kind) return false;
    if (entry.kind === 'source' && other.kind === 'source') {
      return entry.sourceIndex === other.sourceIndex;
    }
    return entry.kind === 'blank'
      && other.kind === 'blank'
      && entry.widthPt === other.widthPt
      && entry.heightPt === other.heightPt;
  });
}

/** Whether the committed document differs from the exact page plan it opened with. */
export function hasDocumentChanges(present: DocPresent, openingPlan: PagePlan): boolean {
  return present.edits.length > 0 || !plansEqual(present.plan, openingPlan);
}

/** Convert committed editor history to durable, structured-cloneable data. */
export function serializeProject(
  history: HistoryState,
  lastPage: number,
  zoom: number,
): SerializedProject {
  const cloned = cloneHistory(history);
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    history: {
      ...cloned,
      past: cloned.past.slice(-SAVED_HISTORY_LIMIT),
    },
    lastPage,
    zoom,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRgb(value: unknown): value is Rgb {
  return isRecord(value)
    && isFiniteNumber(value.r)
    && isFiniteNumber(value.g)
    && isFiniteNumber(value.b)
    && value.r >= 0 && value.r <= 1
    && value.g >= 0 && value.g <= 1
    && value.b >= 0 && value.b <= 1;
}

function isRect(value: unknown): value is PdfRect {
  return isRecord(value)
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.w)
    && isFiniteNumber(value.h)
    && value.w >= 0
    && value.h >= 0;
}

function isReplacedText(value: unknown): value is ReplacedText {
  return isRecord(value)
    && typeof value.text === 'string'
    && isRect(value.rect);
}

function isStyle(value: unknown): value is TextStyle {
  return isRecord(value)
    && typeof value.fontName === 'string'
    && isFiniteNumber(value.fontSizePt)
    && value.fontSizePt > 0
    && typeof value.bold === 'boolean'
    && typeof value.italic === 'boolean'
    && isRgb(value.color)
    && (value.fontRef === undefined || typeof value.fontRef === 'string');
}

function isSpan(value: unknown): value is TextSpan {
  return isRecord(value)
    && typeof value.text === 'string'
    && typeof value.bold === 'boolean'
    && typeof value.italic === 'boolean'
    && (value.fontSizePt === undefined || (isFiniteNumber(value.fontSizePt) && value.fontSizePt > 0))
    && (value.fontName === undefined || typeof value.fontName === 'string')
    && (value.fontRef === undefined || typeof value.fontRef === 'string');
}

function hasValidBaseEdit(value: Record<string, unknown>, livePageCount: number): boolean {
  return typeof value.id === 'string'
    && Number.isInteger(value.pageIndex)
    && (value.pageIndex as number) >= 0
    && (value.pageIndex as number) < livePageCount
    && isRect(value.rect)
    && isFiniteNumber(value.z);
}

function isEdit(value: unknown, livePageCount: number): value is Edit {
  if (!isRecord(value) || !hasValidBaseEdit(value, livePageCount)) return false;
  if (value.kind === 'cover') {
    return typeof value.sampleBackground === 'boolean'
      && (value.color === undefined || isRgb(value.color))
      && (value.replaces === undefined || (
        Array.isArray(value.replaces) && value.replaces.every(isReplacedText)
      ));
  }
  if (value.kind === 'image') return value.bytes instanceof Uint8Array;
  if (value.kind === 'line') {
    return ['x1', 'y1', 'x2', 'y2', 'thicknessPt'].every((key) => isFiniteNumber(value[key]))
      && (value.thicknessPt as number) > 0
      && isRgb(value.color);
  }
  if (value.kind !== 'text') return false;
  const spansValid = (candidate: unknown) => (
    candidate === undefined || (Array.isArray(candidate) && candidate.every(isSpan))
  );
  return typeof value.text === 'string'
    && isStyle(value.style)
    && spansValid(value.spans)
    && spansValid(value.boxSpans)
    && (value.origin === undefined || value.origin === 'free')
    && (value.boxId === undefined || typeof value.boxId === 'string')
    && (value.boxText === undefined || typeof value.boxText === 'string')
    && (value.boxHeight === undefined || (isFiniteNumber(value.boxHeight) && value.boxHeight > 0))
    && (value.align === undefined || value.align === 'left' || value.align === 'center' || value.align === 'right')
    && (value.alignLeftPt === undefined || isFiniteNumber(value.alignLeftPt))
    && (value.alignWidthPt === undefined || (isFiniteNumber(value.alignWidthPt) && value.alignWidthPt > 0));
}

function pagePlanEntryStatus(
  value: unknown,
  sourcePageCount: number,
): 'valid' | 'corrupt' | 'missing-source-page' {
  if (!isRecord(value) || typeof value.id !== 'string') return 'corrupt';
  if (value.kind === 'source') {
    if (!Number.isInteger(value.sourceIndex) || (value.sourceIndex as number) < 0) return 'corrupt';
    return (value.sourceIndex as number) < sourcePageCount ? 'valid' : 'missing-source-page';
  }
  if (value.kind !== 'blank') return 'corrupt';
  return isFiniteNumber(value.widthPt)
    && value.widthPt > 0
    && isFiniteNumber(value.heightPt)
    && value.heightPt > 0
    ? 'valid'
    : 'corrupt';
}

function presentStatus(
  value: unknown,
  sourcePageCount: number,
): 'valid' | 'corrupt' | 'missing-source-page' {
  if (!isRecord(value)) return 'corrupt';
  const candidatePlan = value.plan;
  if (!Array.isArray(candidatePlan) || candidatePlan.length === 0) return 'corrupt';
  const ids = new Set<string>();
  for (const entry of candidatePlan) {
    const status = pagePlanEntryStatus(entry, sourcePageCount);
    if (status !== 'valid') return status;
    const id = (entry as Record<string, unknown>).id as string;
    if (ids.has(id)) return 'corrupt';
    ids.add(id);
  }
  if (!Array.isArray(value.edits) || !value.edits.every((edit) => isEdit(edit, candidatePlan.length))) {
    return 'corrupt';
  }
  return 'valid';
}

function historyStatus(
  value: unknown,
  sourcePageCount: number,
): 'valid' | 'corrupt' | 'missing-source-page' {
  if (!isRecord(value) || !Array.isArray(value.past) || !Array.isArray(value.future)) return 'corrupt';
  for (const present of [...value.past, value.present, ...value.future]) {
    const status = presentStatus(present, sourcePageCount);
    if (status !== 'valid') return status;
  }
  return 'valid';
}

/** Validate and restore saved data without allowing corrupt storage to throw into the editor. */
export function deserializeProject(
  value: unknown,
  sourcePageCount: number,
): DeserializeProjectResult {
  try {
    if (!isRecord(value) || value.formatVersion !== PROJECT_FORMAT_VERSION) {
      return {
        ok: false,
        reason: 'unknown-version',
        error: 'This saved file uses an unsupported format.',
      };
    }
    const status = historyStatus(value.history, sourcePageCount);
    const lastPage = value.lastPage;
    const zoom = value.zoom;
    if (status === 'missing-source-page') {
      return {
        ok: false,
        reason: status,
        error: 'This saved file refers to a source page that is missing.',
      };
    }
    if (
      status !== 'valid'
      || !Number.isInteger(lastPage)
      || !isFiniteNumber(zoom)
      || zoom <= 0
    ) {
      return { ok: false, reason: 'corrupt', error: 'This saved file is damaged.' };
    }
    const history = value.history as unknown as HistoryState;
    if ((lastPage as number) < 0 || (lastPage as number) >= history.present.plan.length) {
      return { ok: false, reason: 'corrupt', error: 'This saved file is damaged.' };
    }
    return {
      ok: true,
      value: {
        history: cloneHistory(history),
        lastPage: lastPage as number,
        zoom,
      },
    };
  } catch {
    return { ok: false, reason: 'corrupt', error: 'This saved file is damaged.' };
  }
}

export function cloneSerializedProject(state: SerializedProject): SerializedProject {
  return serializeProject(state.history, state.lastPage, state.zoom);
}
