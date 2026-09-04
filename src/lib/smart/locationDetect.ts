import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfRect } from '@/lib/export/types';
import { defaultProviders, providerConfig } from '@/lib/providers';
import type { ChatMessage, LanguageProvider } from '@/lib/providers/types';
import { DOCUMENT_TEXT_CHAR_LIMIT } from '@/lib/pdf/documentText';
import { extractTextRuns, mergeRunsIntoLines } from '@/lib/pdf/textContent';
import type { TextLine, TextRun } from '@/lib/pdf/textContent';

export interface DetectedLocation {
  readonly text: string;
  readonly kind: 'location';
  readonly pageIndex: number;
  readonly rect: PdfRect;
}

interface TextSegment {
  readonly run: TextRun;
  readonly start: number;
  readonly end: number;
}

interface MappedLine {
  readonly text: string;
  readonly segments: readonly TextSegment[];
  readonly line: TextLine;
}

interface IndexedLocation {
  readonly start: number;
  readonly end: number;
  readonly location: DetectedLocation;
}

const LOCATION_DETECTION_PROMPT = [
  'You are a precise information extractor.',
  'Return ONLY a JSON array of the exact geographic-location strings that appear verbatim in the text.',
  'Include cities, states, countries, regions, landmarks, natural features, and addresses.',
  'Do not include people, organizations, companies, products, events, dates, prose, markdown, or citations.',
  'Output JSON only, for example ["Goa","Morjim"]. Return [] if none.',
].join(' ');

const BLOCKED_ENTITY_WORDS = new Set([
  'agency',
  'bank',
  'board',
  'college',
  'committee',
  'company',
  'corporation',
  'council',
  'department',
  'festival',
  'foundation',
  'games',
  'inc',
  'institute',
  'limited',
  'ltd',
  'meeting',
  'ministry',
  'olympics',
  'organisation',
  'organization',
  'school',
  'summit',
  'university',
]);
const PERSON_TITLE_PATTERN = /(?:^|\s)(?:dr|mr|mrs|ms|miss|prof|professor)\.?\s*$/i;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const locationCache = new WeakMap<PDFDocumentProxy, Promise<DetectedLocation[]>>();

function unionRects(rects: readonly PdfRect[]): PdfRect {
  const first = rects[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const bottom = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

function mappedLine(line: TextLine): MappedLine {
  let text = '';
  let previous: TextRun | undefined;
  const segments: TextSegment[] = [];

  for (const run of [...line.runs].sort((left, right) => left.rect.x - right.rect.x)) {
    const part = run.text.trim();
    if (!part) continue;
    if (previous) {
      const gap = run.rect.x - (previous.rect.x + previous.rect.w);
      const threshold = Math.max(
        0.75,
        Math.min(previous.style.fontSizePt, run.style.fontSizePt) * 0.08,
      );
      const punctuation = /^[,.;:!?%)}\]]/.test(part) || '([{/'.includes(text.at(-1) ?? '');
      if (gap > threshold && !punctuation) text += ' ';
    }
    const start = text.length;
    text += part;
    segments.push({ run, start, end: text.length });
    previous = run;
  }

  return { text, segments, line };
}

function matchRect(source: MappedLine, start: number, end: number): PdfRect {
  const rects: PdfRect[] = [];
  for (const segment of source.segments) {
    const overlapStart = Math.max(start, segment.start);
    const overlapEnd = Math.min(end, segment.end);
    if (overlapStart >= overlapEnd) continue;
    const length = Math.max(1, segment.end - segment.start);
    const from = (overlapStart - segment.start) / length;
    const to = (overlapEnd - segment.start) / length;
    rects.push({
      x: segment.run.rect.x + segment.run.rect.w * from,
      y: segment.run.rect.y,
      w: segment.run.rect.w * (to - from),
      h: segment.run.rect.h,
    });
  }
  return rects.length > 0 ? unionRects(rects) : source.line.rect;
}

function parseStringArray(value: string): string[] {
  const candidates = [
    ...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi),
  ].map((match) => match[1] ?? '');
  candidates.push(...(value.match(/\[[\s\S]*?\]/g) ?? []));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed;
      }
    } catch {
      // Try the next bracketed candidate; providers sometimes wrap JSON in prose.
    }
  }
  return [];
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function candidateLooksGeographic(value: string): boolean {
  if (value.length < 2 || value.length > 140 || /[\r\n]/.test(value)) return false;
  const parts = words(value);
  if (parts.length === 0 || parts.length > 14) return false;
  if (parts.every((part) => /^\d+$/.test(part))) return false;
  if (parts.some((part) => BLOCKED_ENTITY_WORDS.has(part))) return false;
  if (parts.length === 1 && /^\p{Ll}/u.test(value)) return false;
  return true;
}

function hasWordBoundaries(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  return (!before || !WORD_CHARACTER.test(before)) && (!after || !WORD_CHARACTER.test(after));
}

function contextLooksNonGeographic(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 28), start);
  const after = text.slice(end, Math.min(text.length, end + 28));
  if (PERSON_TITLE_PATTERN.test(before)) return true;
  const adjacentAfter = after.match(/^\s*[,;:]?\s*([\p{L}]+)/u)?.[1]?.toLowerCase();
  return adjacentAfter ? BLOCKED_ENTITY_WORDS.has(adjacentAfter) : false;
}

/** Parse an AI answer and map every confident, exact location occurrence onto PDF geometry. */
export function mapLocationAnswerToRuns(
  answer: string,
  runs: readonly TextRun[],
): DetectedLocation[] {
  const candidates = [...new Set(
    parseStringArray(answer)
      .map((value) => value.trim())
      .filter(candidateLooksGeographic),
  )].sort((left, right) => right.length - left.length);
  const result: DetectedLocation[] = [];

  for (const source of mergeRunsIntoLines(runs).map(mappedLine)) {
    const found: IndexedLocation[] = [];
    for (const candidate of candidates) {
      let fromIndex = 0;
      while (fromIndex < source.text.length) {
        const start = source.text.indexOf(candidate, fromIndex);
        if (start < 0) break;
        const end = start + candidate.length;
        fromIndex = end;
        const overlaps = found.some((item) => start < item.end && end > item.start);
        if (
          overlaps ||
          !hasWordBoundaries(source.text, start, end) ||
          contextLooksNonGeographic(source.text, start, end)
        ) continue;
        found.push({
          start,
          end,
          location: {
            text: source.text.slice(start, end),
            kind: 'location',
            pageIndex: source.line.pageIndex,
            rect: matchRect(source, start, end),
          },
        });
      }
    }
    result.push(...found.map((item) => item.location));
  }

  return result.sort((left, right) => (
    left.pageIndex - right.pageIndex ||
    right.rect.y - left.rect.y ||
    left.rect.x - right.rect.x
  ));
}

function locationDetectionConfigured(): boolean {
  return providerConfig.mode === 'proxy' || providerConfig.getSarvamKey().trim() !== '';
}

async function detectDocumentLocations(
  doc: PDFDocumentProxy,
  provider: LanguageProvider,
): Promise<DetectedLocation[]> {
  const runs: TextRun[] = [];
  const pageTexts: string[] = [];
  for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
    const page = await doc.getPage(pageIndex + 1);
    const pageRuns = await extractTextRuns(page, pageIndex);
    runs.push(...pageRuns);
    pageTexts.push(mergeRunsIntoLines(pageRuns).map((line) => line.text).join('\n'));
  }

  const documentText = pageTexts.join('\n\n').slice(0, DOCUMENT_TEXT_CHAR_LIMIT);
  return detectLocationsWithProvider(documentText, runs, provider);
}

/** Run the raw structured extraction call without the conversational companion prompt. */
export async function detectLocationsWithProvider(
  documentText: string,
  runs: readonly TextRun[],
  provider: Pick<LanguageProvider, 'complete'>,
): Promise<DetectedLocation[]> {
  const messages: readonly ChatMessage[] = [
    { role: 'system', content: LOCATION_DETECTION_PROMPT },
    { role: 'user', content: documentText },
  ];
  const response = await provider.complete(messages);
  return mapLocationAnswerToRuns(response.text, runs);
}

/** Return one cached location-detection request for this loaded PDF document. */
export function getDocumentLocations(doc: PDFDocumentProxy): Promise<DetectedLocation[]> {
  if (!locationDetectionConfigured()) return Promise.resolve([]);
  const cached = locationCache.get(doc);
  if (cached) return cached;

  const pending = detectDocumentLocations(doc, defaultProviders());
  locationCache.set(doc, pending);
  void pending.catch(() => {
    if (locationCache.get(doc) === pending) locationCache.delete(doc);
  });
  return pending;
}
