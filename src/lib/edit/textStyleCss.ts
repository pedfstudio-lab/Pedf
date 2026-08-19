import type { CSSProperties } from 'react';
import type { TextStyle } from '@/lib/export/types';
import { classifyFontFamily } from '@/lib/pdf/textContent';

const CSS_FAMILIES = {
  serif: '"Times New Roman", Times, serif',
  sans: 'Arial, Helvetica, sans-serif',
  mono: '"Courier New", Courier, monospace',
} as const;

function fontFamily(style: TextStyle): string {
  const fallback = CSS_FAMILIES[classifyFontFamily(style.fontName)];
  if (!style.fontRef) return fallback;
  const embedded = style.fontRef.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${embedded}", ${fallback}`;
}

export function textStyleToCanvasFont(style: TextStyle): string {
  return `${style.italic ? 'italic' : 'normal'} ${style.bold ? 700 : 400} ${style.fontSizePt}px ${fontFamily(style)}`;
}

function colorCss(style: TextStyle): string {
  const { r, g, b } = style.color;
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

export function textStyleToCss(style: TextStyle, zoom: number): CSSProperties {
  return {
    color: colorCss(style),
    fontFamily: fontFamily(style),
    fontSize: `${style.fontSizePt * zoom}px`,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    lineHeight: 1,
  };
}
