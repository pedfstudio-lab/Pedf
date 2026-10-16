import type { TextStyle } from '@/lib/export/types';
import { sfntMetrics } from './sfnt';

export interface FontMatch { readonly family: string; readonly file: string; readonly exact: boolean; readonly scale: number; readonly syntheticBold?: boolean; readonly syntheticItalic?: boolean }
const families = [
  ['carlito', 'Carlito', /calibri|carlito/], ['lato', 'Lato', /lato/],
  ['opensans', 'OpenSans', /opensans/], ['ibmplexsans', 'IBMPlexSans', /ibmplexsans/],
  ['leaguespartan', 'LeagueSpartan', /leaguespartan/], ['notosans', 'NotoSans', /^notosans(?:regular|bold|italic|bolditalic|light|medium|semibold|black|extrabold)*(?:italic)?$/],
  ['sourcesanspro', 'SourceSansPro', /sourcesans(?:pro|3)/],
  ['bricolagegrotesque', 'BricolageGrotesque', /bricolagegrotesque/], ['allura', 'Allura', /allura/],
  ['liberation', 'LiberationMono', /courier|liberationmono/],
  ['liberation', 'LiberationSerif', /times|liberationserif/],
  ['liberation', 'LiberationSans', /^(?:arial|arialmt|helvetica|helveticaneue|liberationsans)(?:regular|bold|italic|oblique|bolditalic|boldoblique)?$/],
] as const;

export function normalizeFontName(name: string): string {
  return name.replace(/^[A-Z]{6}\+/i, '').replace(/PSMT|MT$/gi, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}
export function genericFont(name: string): 'Sans' | 'Serif' | 'Mono' {
  if (/courier|mono|consolas/i.test(name)) return 'Mono';
  return /times|georgia|cambria|serif(?!sans)/i.test(name) ? 'Serif' : 'Sans';
}
const specialWeights: Record<string, readonly string[]> = {
  Lato: ['Black','Light','Semibold','Medium'], OpenSans: ['Light','SemiBold','ExtraBold'],
  IBMPlexSans: ['Light','Medium','SemiBold'], NotoSans: ['Light','Medium','SemiBold','Black','ExtraBold'],
  SourceSansPro: ['Semibold'], BricolageGrotesque: ['SemiBold','ExtraBold'], LeagueSpartan: ['Light','Medium','SemiBold','ExtraBold'],
};
export function matchFont(style: TextStyle): FontMatch {
  const name = style.fontIdentity ?? fontSources.get(style.fontRef ?? '')?.name ?? style.fontName;
  const normalized = normalizeFontName(name);
  const known = families.find(([, , regex]) => regex.test(normalized));
  const [directory, family] = known ?? ['liberation', `Liberation${genericFont(name)}`];
  let weight = style.bold ? 'Bold' : 'Regular';
  if (style.bold === (style.sourceBold ?? style.bold)) {
    weight = specialWeights[family]?.find(value => normalized.includes(value.toLowerCase())) ?? weight;
  }
  let italic = style.italic;
  const syntheticItalic = italic && ['Allura','LeagueSpartan','BricolageGrotesque'].includes(family);
  const syntheticBold = style.bold && family === 'Allura';
  if (syntheticBold) weight = 'Regular';
  if (syntheticItalic) italic = false;
  let variant = italic ? (weight === 'Regular' ? 'Italic' : `${weight}Italic`) : weight;
  if (family === 'SourceSansPro' && italic) variant = weight === 'Regular' ? 'It' : `${weight}It`;
  const ratio = known ? 1 : style.fontWidthScale ?? fontSources.get(style.fontRef ?? '')?.scale ?? 1;
  const legacySpartan = family === 'LeagueSpartan' && style.bold && /#legacy-v011$/i.test(name);
  return { family, file: legacySpartan ? 'leaguespartan-legacy/LeagueSpartan-Bold.ttf' : `${directory}/${family}-${variant}.ttf`, exact: !!known,
    scale: Number.isFinite(ratio) && ratio >= 0.5 && ratio <= 2 ? ratio : 1, syntheticBold, syntheticItalic };
}

interface FontSource { name: string; widths: ReadonlyMap<string, number>; peerWidths?: ReadonlyMap<string, number>; reusable: boolean; scale?: number }
const fontSources = new Map<string, FontSource>();
export function registerSourceFont(ref: string, value: unknown, observed?: ReadonlyMap<string, number>): void {
  if (!value || typeof value !== 'object') return;
  const font = value as { name?: string; type?: string; isType3Font?: boolean; missingFile?: boolean; data?: Uint8Array; toUnicode?: { _map?: Record<string, string> }; widths?: Record<string, number>; fontMatrix?: number[] };
  if (!font.name) return;
  let name = font.name;
  if (/^CIDFont\+/i.test(name) && font.data) name = sfntMetrics(font.data).family ?? name;
  // The corpus uses the original 0.11 League Spartan, not the substantially
  // narrower 2.x redesign. This stable release hint also survives project save.
  if (/LeagueSpartan/i.test(name) && font.data && /Version 0\.11\b/.test(sfntMetrics(font.data).version ?? '')) name += '#legacy-v011';
  const widths = new Map<string, number>();
  const factor = font.isType3Font ? Math.abs(font.fontMatrix?.[0] ?? 0.001) : 0.001;
  for (const [code, text] of Object.entries(font.toUnicode?._map ?? {})) {
    const width = font.widths?.[code]; if (width !== undefined && width > 0) widths.set(text, width * factor);
  }
  for (const [text, width] of observed ?? []) if (width > 0) widths.set(text, width * factor);
  fontSources.set(ref, { name, widths, reusable: ['TrueType','Type1'].includes(font.type ?? '') && !font.isType3Font && font.missingFile !== true });
}
/** Coverage is conservative. The export's existing raw-PDF gate is authoritative. */
export function canUseSourceWord(text: string, style: TextStyle): boolean {
  const source = fontSources.get(style.fontRef ?? '');
  return !!source?.reusable && !(style.sourceBold === true && !style.bold)
    && [...text].every(character => character === ' ' || source.widths.has(character));
}
export function sourceFontIdentity(ref: string): { fontIdentity?: string; fontWidthScale?: number } {
  const source = fontSources.get(ref);
  return source ? { fontIdentity: source.name, ...(source.scale !== undefined ? { fontWidthScale: source.scale } : {}) } : {};
}
/** Nominal advances only; TJ/spacing belongs to Step 5d, not font matching. */
export function sourceFontWidth(text: string, style: TextStyle): number | undefined {
  const source = fontSources.get(style.fontRef ?? ''); if (!source) return undefined;
  let width = 0;
  for (const character of text) {
    const advance = source.widths.get(character) ?? source.peerWidths?.get(character); if (advance === undefined) return undefined;
    width += advance;
  }
  return width * style.fontSizePt;
}

/**
 * Calibrate CSS/PDF character advances on drawn runs, not nominal font widths.
 * Whitespace-free runs keep justification and custom word gaps out of the
 * estimate. Same-name Type3 subsets share only this page's samples. A median
 * ignores individual kerning pairs; tiny rounding noise is not tracking.
 */
export function pageFontTracking(runs: readonly { text: string; rect: { w: number }; style: TextStyle; metrics?: { horizontalScale?: number; matrix?: readonly number[] } }[]): ReadonlyMap<string, number> {
  const groups = new Map<string, number[]>();
  const key = (style: TextStyle) => normalizeFontName(style.fontIdentity ?? style.fontName);
  for (const run of runs) {
    // Matrix/Tz compression is not letter spacing. Existing positioned-text
    // handling remains responsible for those shapes and rotations.
    const matrix = run.metrics?.matrix;
    if (Math.abs((run.metrics?.horizontalScale ?? 1)-1)>1e-6
      || (matrix && (!(matrix[0]!>0 && matrix[3]!>0) || Math.abs(matrix[1]!)>1e-6 || Math.abs(matrix[0]!/matrix[3]!-1)>1e-4))) continue;
    const count = [...run.text].length;
    if (count < 4 || /\s/u.test(run.text) || !(run.style.fontSizePt > 0)) continue;
    const nominal = sourceFontWidth(run.text, run.style);
    if (nominal === undefined) continue;
    const tracking = (run.rect.w - nominal) / (count * run.style.fontSizePt);
    if (!Number.isFinite(tracking) || tracking < -0.2 || tracking > 0.2) continue;
    const name = key(run.style);
    groups.set(name, [...(groups.get(name) ?? []), tracking]);
  }
  const result = new Map<string, number>();
  for (const [name, values] of groups) {
    if (values.length < 3) continue;
    values.sort((a,b) => a-b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle]! : (values[middle-1]! + values[middle]!) / 2;
    if (median < -0.002) result.set(name, median);
  }
  return new Map(runs.flatMap(run => {
    const tracking = result.get(key(run.style));
    return run.style.fontRef && tracking !== undefined ? [[run.style.fontRef, tracking] as const] : [];
  }));
}
export function calibrateSourceFont(ref: string, bytes: Uint8Array, pageRefs: readonly string[] = [ref]): void {
  const source = fontSources.get(ref); if (!source) return;
  const metrics = sfntMetrics(bytes), ratios: number[] = [];
  // Type3 exporters split one face over several subset resources (letters,
  // punctuation, etc.). Calibrating each tiny subset separately would produce
  // different widths inside a single word. Pool only this page's same-name face.
  const widths = new Map<string, number[]>();
  for (const siblingRef of pageRefs) {
    const sibling = fontSources.get(siblingRef);
    if (!sibling || normalizeFontName(sibling.name) !== normalizeFontName(source.name)) continue;
    for (const [text, width] of sibling.widths) widths.set(text, [...(widths.get(text) ?? []), width]);
  }
  for (const [text, samples] of widths) {
    if ([...text].length !== 1 || /\s/u.test(text)) continue;
    samples.sort((a,b)=>a-b); const width = samples[Math.floor(samples.length/2)]!;
    const fallback = metrics.width(text); if (fallback && width > 0) ratios.push(width / fallback);
  }
  source.peerWidths = new Map([...widths].map(([text, samples]) => [text, samples[Math.floor(samples.length/2)]!]));
  ratios.sort((a, b) => a - b);
  if (ratios.length) source.scale = ratios.length % 2 ? ratios[(ratios.length - 1) / 2]! : (ratios[ratios.length / 2 - 1]! + ratios[ratios.length / 2]!) / 2;
}

/** Stable family names include the calibrated width; Canvas needs no variation API. */
export function matchedCssFamily(style: TextStyle): string {
  const match = matchFont(style);
  return `R1-${match.file.replace(/[^a-z0-9]/gi, '-')}-${Math.round(match.scale * 100000)}`;
}
