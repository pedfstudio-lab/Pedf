import type { TextSpan, TextStyle } from '@/lib/export/types';

export interface SerializedRichText {
  readonly text: string;
  readonly style: TextStyle;
  readonly spans?: readonly TextSpan[];
}

const BLOCK_ELEMENTS = new Set(['DIV', 'LI', 'P']);

export function normalizeTextSpans(spans: readonly TextSpan[]): TextSpan[] {
  const normalized: TextSpan[] = [];
  for (const span of spans) {
    const text = span.text.replace(/\r\n?/g, '\n');
    if (!text) continue;
    const previous = normalized.at(-1);
    if (previous && previous.bold === span.bold && previous.italic === span.italic) {
      normalized[normalized.length - 1] = { ...previous, text: previous.text + text };
    } else {
      normalized.push({ text, bold: span.bold, italic: span.italic });
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
  const uniform = first && normalized.every(
    (span) => span.bold === first.bold && span.italic === first.italic,
  );
  if (uniform) {
    return {
      text,
      style: { ...baseStyle, bold: first.bold, italic: first.italic },
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

/** Serialize an uncontrolled contentEditable tree into absolute bold/italic runs. */
export function serializeRichText(root: HTMLElement, baseStyle: TextStyle): SerializedRichText {
  const spans: TextSpan[] = [];
  const append = (text: string, bold: boolean, italic: boolean) => {
    if (text) spans.push({ text, bold, italic });
  };
  const visit = (node: Node, bold: boolean, italic: boolean) => {
    if (node.nodeType === 3) {
      append(node.nodeValue ?? '', bold, italic);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    if (element.tagName === 'BR') {
      append('\n', bold, italic);
      return;
    }
    if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') return;
    if (element !== root && BLOCK_ELEMENTS.has(element.tagName) && textFromSpans(spans) !== '' && !textFromSpans(spans).endsWith('\n')) {
      append('\n', bold, italic);
    }
    const nextBold = weightFromElement(element, bold);
    const nextItalic = italicFromElement(element, italic);
    for (const child of Array.from(element.childNodes)) visit(child, nextBold, nextItalic);
  };

  for (const child of Array.from(root.childNodes)) {
    visit(child, baseStyle.bold, baseStyle.italic);
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

/** Build the editor's initial DOM once; subsequent keystrokes never flow back through React. */
export function richTextToHtml(
  text: string,
  style: Pick<TextStyle, 'bold' | 'italic'>,
  spans?: readonly TextSpan[],
): string {
  if (!spans) return escapeHtml(text.replace(/\r\n?/g, '\n'));
  return effectiveTextSpans(text, style, spans).map((span) => {
    const content = escapeHtml(span.text);
    return `<span style="font-weight:${span.bold ? 'bold' : 'normal'};font-style:${span.italic ? 'italic' : 'normal'}">${content}</span>`;
  }).join('');
}
