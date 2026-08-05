import type { CSSProperties } from 'react';
import type { TextStyle } from '@/lib/export/types';
import { classifyFontFamily } from '@/lib/pdf/textContent';

const CSS_FAMILIES = {
  serif: '"Times New Roman", Times, serif',
  sans: 'Arial, Helvetica, sans-serif',
  mono: '"Courier New", Courier, monospace',
} as const;

export function textStyleToCanvasFont(style: TextStyle): string {
  const family = CSS_FAMILIES[classifyFontFamily(style.fontName)];
  return `${style.italic ? 'italic' : 'normal'} ${style.bold ? 700 : 400} ${style.fontSizePt}px ${family}`;
}

function colorCss(style: TextStyle): string {
  const { r, g, b } = style.color;
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

export function textStyleToCss(style: TextStyle, zoom: number): CSSProperties {
  return {
    color: colorCss(style),
    fontFamily: CSS_FAMILIES[classifyFontFamily(style.fontName)],
    fontSize: `${style.fontSizePt * zoom}px`,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    lineHeight: 1,
  };
}
