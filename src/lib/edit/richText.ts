import type { Rgb, TextSpan, TextStyle } from '@/lib/export/types';
import type { TextBlock, TextRun } from '@/lib/pdf/textContent';

export interface SerializedRichText {
  readonly text: string;
  readonly style: TextStyle;
  readonly spans?: readonly TextSpan[];
}

const BLOCK_ELEMENTS = new Set(['DIV', 'LI', 'P']);

function sameColor(left: Rgb | undefined, right: Rgb | undefined): boolean {
  if (!left || !right) return left === right;
  return left.r === right.r && left.g === right.g && left.b === right.b;
}

function sameSpanStyle(left: TextSpan, right: TextSpan): boolean {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.fontSizePt === right.fontSizePt &&
    left.fontName === right.fontName &&
    left.fontRef === right.fontRef &&
    sameColor(left.color, right.color) &&
    left.sourceBold === right.sourceBold &&
    left.sourceStrokeBold === right.sourceStrokeBold &&
    left.colorKnown === right.colorKnown
  );
}

export function effectiveTextSpanStyle(baseStyle: TextStyle, span: TextSpan): TextStyle {
  const changesFamily = span.fontName !== undefined && span.fontName !== baseStyle.fontName;
  return {
    ...baseStyle,
    bold: span.bold,
    italic: span.italic,
    fontSizePt: span.fontSizePt ?? baseStyle.fontSizePt,
    fontName: span.fontName ?? baseStyle.fontName,
    fontRef: changesFamily ? span.fontRef : (span.fontRef ?? baseStyle.fontRef),
    color: span.color ?? baseStyle.color,
    sourceBold: changesFamily ? span.sourceBold : (span.sourceBold ?? baseStyle.sourceBold),
    sourceStrokeBold: changesFamily
      ? span.sourceStrokeBold
      : (span.sourceStrokeBold ?? baseStyle.sourceStrokeBold),
    colorKnown: span.color ? true : (span.colorKnown ?? baseStyle.colorKnown),
  };
}

function spanForRun(text: string, run: TextRun, baseStyle: TextStyle): TextSpan {
  const style = run.style;
  return {
    text,
    bold: style.bold,
    italic: style.italic,
    ...(style.fontSizePt !== baseStyle.fontSizePt ? { fontSizePt: style.fontSizePt } : {}),
    ...(style.fontName !== baseStyle.fontName ? { fontName: style.fontName } : {}),
    ...(style.fontRef !== baseStyle.fontRef && style.fontRef ? { fontRef: style.fontRef } : {}),
    ...(!sameColor(style.color, baseStyle.color) ? { color: style.color } : {}),
    ...(style.sourceBold !== baseStyle.sourceBold && style.sourceBold !== undefined
      ? { sourceBold: style.sourceBold }
      : {}),
    ...(style.sourceStrokeBold !== baseStyle.sourceStrokeBold && style.sourceStrokeBold !== undefined
      ? { sourceStrokeBold: style.sourceStrokeBold }
      : {}),
    ...(style.colorKnown !== baseStyle.colorKnown && style.colorKnown !== undefined
      ? { colorKnown: style.colorKnown }
      : {}),
  };
}

/** Convert source run styling into editor spans without changing the block's text. */
export function sourceSpansForTextBlock(
  block: TextBlock,
  targetText = block.text,
): readonly TextSpan[] | undefined {
  const spans: TextSpan[] = [];
  for (const [lineIndex, line] of block.lines.entries()) {
    let cursor = 0;
    let lastRun: TextRun | undefined;
    for (const run of [...line.runs].sort((left, right) => left.rect.x - right.rect.x)) {
      const part = run.text.trim();
      if (!part) continue;
      const start = line.text.indexOf(part, cursor);
      if (start < cursor) return undefined;
      spans.push(spanForRun(line.text.slice(cursor, start) + part, run, block.style));
      cursor = start + part.length;
      lastRun = run;
    }
    if (cursor < line.text.length) {
      if (!lastRun) return undefined;
      spans.push(spanForRun(line.text.slice(cursor), lastRun, block.style));
    }
    if (lineIndex < block.lines.length - 1) {
      const owner = lastRun ?? line.runs.at(-1);
      if (!owner) return undefined;
      spans.push(spanForRun('\n', owner, block.style));
    }
  }
  const sourceText = textFromSpans(spans);
  if (sourceText !== block.text) return undefined;
  const adjusted = targetText === sourceText
    ? spans
    : targetText === sourceText.replace(/\n/g, ' ')
      ? spans.map((span) => ({ ...span, text: span.text.replace(/\n/g, ' ') }))
      : undefined;
  if (!adjusted) return undefined;
  return finalizeTextSpans(adjusted, block.style).spans;
}

export function normalizeTextSpans(spans: readonly TextSpan[]): TextSpan[] {
  const normalized: TextSpan[] = [];
  for (const span of spans) {
    const text = span.text.replace(/\r\n?/g, '\n');
    if (!text) continue;
    const previous = normalized.at(-1);
    if (previous && sameSpanStyle(previous, span)) {
      normalized[normalized.length - 1] = { ...previous, text: previous.text + text };
    } else {
      normalized.push({ ...span, text });
    }
  }
  return normalized;
}

export function textFromSpans(spans: readonly TextSpan[]): string {
  return spans.map((span) => span.text).join('');
}

export function effectiveTextSpans(
  text: string,
  style: Pick<TextStyle, 'bold' | 'italic'>,
  spans?: readonly TextSpan[],
): TextSpan[] {
  const normalized = spans ? normalizeTextSpans(spans) : [];
  if (normalized.length > 0 && textFromSpans(normalized) === text) return normalized;
  return text ? [{ text, bold: style.bold, italic: style.italic }] : [];
}

/** Collapse DOM runs and keep the common uniform case on the legacy plain TextEdit path. */
export function finalizeTextSpans(
  spans: readonly TextSpan[],
  baseStyle: TextStyle,
): SerializedRichText {
  const normalized = normalizeTextSpans(spans);
  const text = textFromSpans(normalized);
  const first = normalized[0];
  const uniform = first && normalized.every((span) => sameSpanStyle(span, first));
  if (uniform) {
    return {
      text,
      style: effectiveTextSpanStyle(baseStyle, first),
    };
  }
  return normalized.length > 0
    ? { text, style: baseStyle, spans: normalized }
    : { text: '', style: baseStyle };
}

function weightFromElement(element: HTMLElement, inherited: boolean): boolean {
  let bold = inherited || element.tagName === 'B' || element.tagName === 'STRONG';
  const weight = element.style?.fontWeight?.toLowerCase();
  if (weight === 'normal' || /^[1-5]00$/.test(weight)) bold = false;
  if (weight === 'bold' || /^[6-9]00$/.test(weight)) bold = true;
  return bold;
}

function italicFromElement(element: HTMLElement, inherited: boolean): boolean {
  let italic = inherited || element.tagName === 'I' || element.tagName === 'EM';
  const fontStyle = element.style?.fontStyle?.toLowerCase();
  if (fontStyle === 'normal') italic = false;
  if (fontStyle === 'italic' || fontStyle === 'oblique') italic = true;
  return italic;
}

function fontSizeFromElement(element: HTMLElement, inherited: number, zoom: number): number {
  const dataSize = Number.parseFloat(element.dataset?.fontSizePt ?? '');
  if (Number.isFinite(dataSize) && dataSize > 0) return dataSize;
  const fontSize = Number.parseFloat(element.style?.fontSize ?? '');
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize / zoom : inherited;
}

function fontNameFromElement(element: HTMLElement, inherited: string): string {
  const dataName = element.dataset?.fontName?.trim();
  if (dataName) return dataName;
  const inline = element.style?.fontFamily?.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
  return inline || inherited;
}

function fontRefFromElement(
  element: HTMLElement,
  inherited: string | undefined,
  familyChanged: boolean,
): string | undefined {
  const dataRef = element.dataset?.fontRef?.trim();
  if (dataRef) return dataRef;
  return familyChanged ? undefined : inherited;
}

function cssColor(value: string): Rgb | undefined {
  const channels = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (channels) {
    return {
      r: Math.min(1, Math.max(0, Number(channels[1]) / 255)),
      g: Math.min(1, Math.max(0, Number(channels[2]) / 255)),
      b: Math.min(1, Math.max(0, Number(channels[3]) / 255)),
    };
  }
  const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!hex) return undefined;
  return {
    r: Number.parseInt(hex[1] ?? '00', 16) / 255,
    g: Number.parseInt(hex[2] ?? '00', 16) / 255,
    b: Number.parseInt(hex[3] ?? '00', 16) / 255,
  };
}

function colorFromElement(element: HTMLElement, inherited: Rgb): Rgb {
  const data = element.dataset?.textColor?.split(',').map(Number);
  if (data?.length === 3 && data.every(Number.isFinite)) {
    return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0 };
  }
  return cssColor(element.style?.color ?? '') ?? inherited;
}

function sourceBoldFromElement(element: HTMLElement, inherited: boolean | undefined): boolean | undefined {
  if (element.dataset?.sourceBold === 'true') return true;
  if (element.dataset?.sourceBold === 'false') return false;
  return inherited;
}

function sourceStrokeBoldFromElement(
  element: HTMLElement,
  inherited: boolean | undefined,
): boolean | undefined {
  if (element.dataset?.sourceStrokeBold === 'true') return true;
  if (element.dataset?.sourceStrokeBold === 'false') return false;
  return inherited;
}

function colorKnownFromElement(element: HTMLElement, inherited: boolean | undefined): boolean | undefined {
  if (element.dataset?.colorKnown === 'true') return true;
  if (element.dataset?.colorKnown === 'false') return false;
  return element.style?.color || element.dataset?.textColor ? true : inherited;
}

/** Serialize an uncontrolled contentEditable tree into absolute bold/italic runs. */
export function serializeRichText(
  root: HTMLElement,
  baseStyle: TextStyle,
  zoom = 1,
): SerializedRichText {
  const spans: TextSpan[] = [];
  const append = (text: string, current: TextStyle) => {
    if (!text) return;
    spans.push({
      text,
      bold: current.bold,
      italic: current.italic,
      ...(current.fontSizePt !== baseStyle.fontSizePt ? { fontSizePt: current.fontSizePt } : {}),
      ...(current.fontName !== baseStyle.fontName ? { fontName: current.fontName } : {}),
      ...(current.fontRef !== baseStyle.fontRef && current.fontRef ? { fontRef: current.fontRef } : {}),
      ...(!sameColor(current.color, baseStyle.color) ? { color: current.color } : {}),
      ...(current.sourceBold !== baseStyle.sourceBold ? { sourceBold: current.sourceBold } : {}),
      ...(current.sourceStrokeBold !== baseStyle.sourceStrokeBold
        ? { sourceStrokeBold: current.sourceStrokeBold }
        : {}),
      ...(current.colorKnown !== baseStyle.colorKnown ? { colorKnown: current.colorKnown } : {}),
    });
  };
  const visit = (node: Node, inherited: TextStyle) => {
    if (node.nodeType === 3) {
      append(node.nodeValue ?? '', inherited);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    if (element.tagName === 'BR') {
      append('\n', inherited);
      return;
    }
    if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') return;
    if (element !== root && BLOCK_ELEMENTS.has(element.tagName) && textFromSpans(spans) !== '' && !textFromSpans(spans).endsWith('\n')) {
      append('\n', inherited);
    }
    const fontName = fontNameFromElement(element, inherited.fontName);
    const color = colorFromElement(element, inherited.color);
    const next: TextStyle = {
      ...inherited,
      bold: weightFromElement(element, inherited.bold),
      italic: italicFromElement(element, inherited.italic),
      fontSizePt: fontSizeFromElement(element, inherited.fontSizePt, zoom),
      fontName,
      fontRef: fontRefFromElement(element, inherited.fontRef, fontName !== inherited.fontName),
      color,
      sourceBold: sourceBoldFromElement(
        element,
        fontName !== inherited.fontName ? undefined : inherited.sourceBold,
      ),
      sourceStrokeBold: sourceStrokeBoldFromElement(
        element,
        fontName !== inherited.fontName ? undefined : inherited.sourceStrokeBold,
      ),
      colorKnown: colorKnownFromElement(element, inherited.colorKnown),
    };
    for (const child of Array.from(element.childNodes)) visit(child, next);
  };

  for (const child of Array.from(root.childNodes)) {
    visit(child, baseStyle);
  }
  return finalizeTextSpans(spans, baseStyle);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function cssFontFamily(span: TextSpan): string | undefined {
  if (!span.fontName && !span.fontRef) return undefined;
  const family = span.fontName ?? 'sans-serif';
  return span.fontRef ? `"${span.fontRef.replace(/"/g, '\\"')}", ${family}` : family;
}

function colorCss(color: Rgb): string {
  return `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
}

/** Build the editor's initial DOM once; subsequent keystrokes never flow back through React. */
export function richTextToHtml(
  text: string,
  style: TextStyle,
  spans?: readonly TextSpan[],
  zoom = 1,
): string {
  if (!spans) return escapeHtml(text.replace(/\r\n?/g, '\n'));
  return effectiveTextSpans(text, style, spans).map((span) => {
    const content = escapeHtml(span.text);
    const family = cssFontFamily(span);
    const declarations = [
      `font-weight:${span.bold ? 'bold' : 'normal'}`,
      `font-style:${span.italic ? 'italic' : 'normal'}`,
      ...(span.fontSizePt ? [`font-size:${span.fontSizePt * zoom}px`] : []),
      ...(family ? [`font-family:${family}`] : []),
      ...(span.color ? [`color:${colorCss(span.color)}`] : []),
    ].join(';');
    const data = [
      ...(span.fontSizePt ? [` data-font-size-pt="${span.fontSizePt}"`] : []),
      ...(span.fontName ? [` data-font-name="${escapeAttribute(span.fontName)}"`] : []),
      ...(span.fontRef ? [` data-font-ref="${escapeAttribute(span.fontRef)}"`] : []),
      ...(span.color ? [` data-text-color="${span.color.r},${span.color.g},${span.color.b}"`] : []),
      ...(span.sourceBold !== undefined ? [` data-source-bold="${span.sourceBold}"`] : []),
      ...(span.sourceStrokeBold !== undefined
        ? [` data-source-stroke-bold="${span.sourceStrokeBold}"`]
        : []),
      ...(span.colorKnown !== undefined ? [` data-color-known="${span.colorKnown}"`] : []),
    ].join('');
    return `<span style="${declarations}"${data}>${content}</span>`;
  }).join('');
}
