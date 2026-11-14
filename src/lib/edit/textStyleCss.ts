import type { CSSProperties } from 'react';
import type { TextStyle } from '@/lib/export/types';
import { classifyFontFamily } from '@/lib/pdf/textContent';
import { canUseSourceWord, matchedCssFamily } from '@/lib/fonts/fontMatch';

const CSS_FAMILIES = {
  serif: '"Times New Roman", Times, serif',
  sans: 'Arial, Helvetica, sans-serif',
  mono: '"Courier New", Courier, monospace',
} as const;

/**
 * A font name from a PDF can contain anything, including characters that would end a CSS rule
 * and start another (`;`, `{`, `(` …), so a crafted PDF could add its own styles. Keep only what
 * a font-family list needs.
 */
export function safeCssFontList(name: string): string {
  return name.replace(/[;{}()<>\\"'`\r\n]/g, '').replace(/\s+/g, ' ').trim() || 'sans-serif';
}

/** A value inside a CSS "…" string: escape what could close it. */
export function cssStringContent(value: string): string {
  return value.replace(/[\r\n]/g, '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function textFontFamily(style: TextStyle, text?: string): string {
  const fallback = CSS_FAMILIES[classifyFontFamily(style.fontName)];
  const matched = `"${matchedCssFamily(style)}", ${fallback}`;
  if (!style.fontRef || (text !== undefined && !canUseSourceWord(text, style))) return matched;
  return `"${cssStringContent(style.fontRef)}", ${matched}`;
}

export function textStyleToCanvasFont(style: TextStyle, text?: string): string {
  return `${style.italic ? 'italic' : 'normal'} ${style.bold ? 700 : 400} ${style.fontSizePt}px ${textFontFamily(style, text)}`;
}

/** Shared by the live editor and the Done/list wrapping seams. */
export function measureMatchedText(context: CanvasRenderingContext2D, text: string, style: TextStyle): number {
  return (text.match(/\s+|\S+/gu) ?? []).reduce((sum, word) => {
    context.font = textStyleToCanvasFont(style, word);
    context.fontKerning = 'none';
    return sum + context.measureText(word).width + [...word].length * (style.fontTrackingEm ?? 0) * style.fontSizePt;
  }, 0);
}

function colorCss(style: TextStyle): string {
  const { r, g, b } = style.color;
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

export function textStyleToCss(style: TextStyle, zoom: number, text?: string): CSSProperties {
  return {
    color: colorCss(style),
    fontFamily: textFontFamily(style, text),
    fontKerning: 'none',
    fontVariantLigatures: 'none',
    fontSize: `${style.fontSizePt * zoom}px`,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    ...(style.fontTrackingEm !== undefined ? { letterSpacing: `${style.fontTrackingEm * style.fontSizePt * zoom}px` } : {}),
    lineHeight: 1,
  };
}
