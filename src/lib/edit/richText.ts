import type { TextSpan, TextStyle } from '@/lib/export/types';

export interface SerializedRichText {
  readonly text: string;
  readonly style: TextStyle;
  readonly spans?: readonly TextSpan[];
}

const BLOCK_ELEMENTS = new Set(['DIV', 'LI', 'P']);

function sameSpanStyle(left: TextSpan, right: TextSpan): boolean {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.fontSizePt === right.fontSizePt &&
    left.fontName === right.fontName &&
    left.fontRef === right.fontRef
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
  };
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
    const next: TextStyle = {
      ...inherited,
      bold: weightFromElement(element, inherited.bold),
      italic: italicFromElement(element, inherited.italic),
      fontSizePt: fontSizeFromElement(element, inherited.fontSizePt, zoom),
      fontName,
      fontRef: fontRefFromElement(element, inherited.fontRef, fontName !== inherited.fontName),
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
    ].join(';');
    const data = [
      ...(span.fontSizePt ? [` data-font-size-pt="${span.fontSizePt}"`] : []),
      ...(span.fontName ? [` data-font-name="${escapeAttribute(span.fontName)}"`] : []),
      ...(span.fontRef ? [` data-font-ref="${escapeAttribute(span.fontRef)}"`] : []),
    ].join('');
    return `<span style="${declarations}"${data}>${content}</span>`;
  }).join('');
}
