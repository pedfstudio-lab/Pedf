import type { TextLine } from './textContent';
import { fontFamily } from './textUnits';
import type { TextBlock } from './textContent';
import type { RuleLine } from './ruleLines';

/** A page's measured normal leading, grouped by face family and size. */
export function pageLinePitches(lines: readonly TextLine[]): ReadonlyMap<TextLine, number> {
  const keys = new Map(lines.map(line => [line, `${line.pageIndex}:${fontFamily(line.style.fontName)}:${Math.round(line.style.fontSizePt * 10)}`]));
  const key = (line: TextLine) => keys.get(line)!;
  const byKey = new Map<string, TextLine[]>();
  for (const line of lines) {
    const group = byKey.get(key(line)) ?? [];
    group.push(line); byKey.set(key(line), group);
  }
  // Lowest baseline first, so the first overlapping line found above is the nearest.
  for (const group of byKey.values()) group.sort((a, b) => a.baselineY - b.baselineY);
  const samples = new Map<string, number[]>();
  for (const line of lines) {
    const candidates = byKey.get(key(line))!;
    let low = 0, high = candidates.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (candidates[middle]!.baselineY - line.baselineY > 0.5) high = middle; else low = middle + 1;
    }
    let previous: TextLine | undefined;
    for (let index = low; index < candidates.length; index += 1) {
      const other = candidates[index]!;
      const gap = other.baselineY - line.baselineY;
      if (gap > line.style.fontSizePt * 1.85) break;
      if (Math.min(other.rect.x + other.rect.w, line.rect.x + line.rect.w) > Math.max(other.rect.x, line.rect.x)) {
        previous = other; break;
      }
    }
    if (!previous) continue;
    const group = samples.get(key(line)) ?? [];
    group.push(previous.baselineY - line.baselineY); samples.set(key(line), group);
  }
  const modes = new Map<string, number>();
  for (const [key, gaps] of samples) {
    const buckets = new Map<number, number[]>();
    for (const gap of gaps) {
      const bucket = Math.round(gap * 2), values = buckets.get(bucket) ?? [];
      values.push(gap); buckets.set(bucket, values);
    }
    const best = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0]?.[1];
    if (!best || best.length < 2) continue; // No repeatable pitch: do not guess.
    modes.set(key, best.reduce((a, b) => a + b, 0) / best.length);
  }
  return new Map(lines.flatMap(line => {
    const pitch = modes.get(key(line)); return pitch === undefined ? [] : [[line, pitch] as const];
  }));
}

export function biggerParagraphGap(upper: TextLine, lower: TextLine, pitches: ReadonlyMap<TextLine, number>): boolean {
  const pitch = Math.max(pitches.get(upper) ?? 0, pitches.get(lower) ?? 0);
  return pitch > 0 && upper.baselineY - lower.baselineY > pitch * 1.3 + 0.001;
}

/** Keep a ruled cell atomic: Part A preserves paragraph spacing inside it. */
export function inRuledColumn(block: TextBlock, rules: readonly RuleLine[]): boolean {
  const sides = rules.filter(rule => rule.pageIndex === block.pageIndex && rule.orientation === 'vertical'
    && Math.min(rule.y1, rule.y2) <= block.rect.y + 1
    && Math.max(rule.y1, rule.y2) >= block.rect.y + block.rect.h - 1);
  return sides.some(side => side.x1 <= block.rect.x + 1)
    && sides.some(side => side.x1 >= block.rect.x + block.rect.w - 1);
}
