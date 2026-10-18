import { concatTransformationMatrix, degrees, popGraphicsState, pushGraphicsState, rgb, setCharacterSpacing, setCharacterSqueeze, setTextRenderingMode, setWordSpacing, setLineWidth, setStrokingRgbColor, TextRenderingMode } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import { indicLanguage, withoutIndicText } from '@/lib/translate/indicText';
import { resolveEnglishFont } from '../englishFont';
import { drawSpanWithPageFont, measureTextWithPageFont } from '../embeddedFont';
import type { TextEdit, TextStyle } from '../types';
import type { EditHandler } from '../registry';
import { effectiveTextSpanStyle } from '@/lib/edit/richText';
import { isArrowBullet } from '@/lib/pdf/symbolBullets';
import { drawArrowMarker, markerShapeWidth } from '../markerShapes';
import type { PageExportContext } from '../context';
import { positionedComposition } from '@/lib/edit/textLayout';
import { matchFont } from '@/lib/fonts/fontMatch';
import { fallbackWordRanges, locateFragments, overlapsFallback } from '@/lib/fonts/wordFonts';
import type { WordRange } from '@/lib/fonts/wordFonts';

function alignedTextX(edit: TextEdit, textWidth: number): number {
  const align = edit.align ?? 'left';
  if (align === 'left' || align === 'justify') return edit.rect.x;
  const left = edit.alignLeftPt ?? edit.rect.x;
  const width = edit.alignWidthPt ?? edit.rect.w;
  return align === 'center'
    ? left + (width - textWidth) / 2
    : left + width - textWidth;
}

function exportStyle(style: TextStyle): TextStyle {
  // Turning B off on an intrinsically-bold face cannot reuse that face; doing
  // so would make the control lie. Old projects without sourceBold keep their
  // legacy font-reuse behaviour.
  return style.sourceBold === true && !style.bold
    ? { ...style, fontRef: undefined }
    : style;
}

function syntheticBold(style: TextStyle): boolean {
  return style.bold && (style.sourceStrokeBold === true || style.sourceBold !== true);
}

interface PreparedText { text: string; style: TextStyle; width: number; font?: PDFFont; arrow?: boolean; scale?: number }
async function prepareText(text: string, style: TextStyle, context: PageExportContext, offset = 0, fallback: readonly WordRange[] = []): Promise<PreparedText[]> {
  const parts = text.match(/[➢\uF0D8]|\s+|[^\s➢\uF0D8]+/gu) ?? [], result: PreparedText[] = [];
  let cursor = offset;
  for (const part of parts) {
    const tracking = (style.fontTrackingEm ?? 0) * style.fontSizePt * [...part].length;
    const forceFallback = overlapsFallback(cursor, part.length, fallback); cursor += part.length;
    if (isArrowBullet(part)) { result.push({ text:'➢',style,width:markerShapeWidth(style),arrow:true }); continue; }
    const pageWidth = forceFallback ? null : measureTextWithPageFont(part,style,context);
    if (pageWidth !== null) { result.push({text:part,style,width:pageWidth+tracking}); continue; }
    const font = await resolveEnglishFont(style,context);
    const scale = matchFont(style).scale;
    const supported = new Set(font.getCharacterSet());
    try {
      if ([...part].some(character => !supported.has(character.codePointAt(0)!))) throw new Error('missing glyph');
      result.push({ text:part,style,width:font.widthOfTextAtSize(part,style.fontSizePt) * scale+tracking,font,scale });
    }
    catch {
      let safe = '';
      const flush = () => { if (safe) result.push({text:safe,style,width:font.widthOfTextAtSize(safe,style.fontSizePt) * scale+[...safe].length*(style.fontTrackingEm ?? 0)*style.fontSizePt,font,scale}); safe = ''; };
      for (const character of part) {
        try { if (!supported.has(character.codePointAt(0)!)) throw new Error('missing glyph'); font.encodeText(character); safe += character; }
        catch {
          flush();
          const warning = `Skipped unsupported character U+${character.codePointAt(0)!.toString(16).toUpperCase()} on page ${context.geometry.pageIndex + 1}: the selected font cannot encode it.`;
          if (!context.warnings.includes(warning)) context.warnings.push(warning);
        }
      }
      flush();
    }
  }
  // Preserve a continuous PDF text object when adjacent words use one face.
  // Separate Tj/text objects for every space confuse extraction/search readers.
  const merged: PreparedText[] = [];
  for (const item of result) {
    const previous = merged.at(-1);
    if (previous && !previous.arrow && !item.arrow && previous.font === item.font && previous.scale === item.scale) {
      previous.text += item.text; previous.width += item.width;
    } else merged.push({ ...item });
  }
  return merged;
}

function drawPrepared(item: PreparedText, x: number, y: number, context: PageExportContext): void {
  if (item.arrow) { drawArrowMarker(item.style, x, y, context); return; }
  if (!item.font) {
    if (item.style.fontTrackingEm !== undefined) {
      // Keep one Tj so extraction/search sees the original complete phrase.
      // The unchanged page-font drawer inherits this bounded text state.
      context.page.pushOperators(pushGraphicsState(),setCharacterSpacing(item.style.fontTrackingEm*item.style.fontSizePt));
      drawSpanWithPageFont(item.text,item.style,x,y,syntheticBold(item.style),item.style.italic,context);
      context.page.pushOperators(popGraphicsState());
      return;
    }
    drawSpanWithPageFont(item.text, item.style, x, y, syntheticBold(item.style), item.style.italic, context);
    return;
  }
  const match = matchFont(item.style), color = item.style.color;
  const scaled = item.scale !== undefined && item.scale !== 1;
  context.page.pushOperators(pushGraphicsState());
  if (scaled) context.page.pushOperators(concatTransformationMatrix(item.scale!, 0, 0, 1, x, 0));
  if (item.style.fontTrackingEm !== undefined) context.page.pushOperators(setCharacterSpacing(item.style.fontTrackingEm * item.style.fontSizePt / (item.scale ?? 1)));
  if (match.syntheticBold) context.page.pushOperators(setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(item.style.fontSizePt * 0.03), setStrokingRgbColor(color.r, color.g, color.b));
  context.page.drawText(item.text, { x: scaled ? 0 : x, y, size: item.style.fontSizePt, font: item.font,
    ...(match.syntheticItalic ? { xSkew: degrees(12) } : {}), color: rgb(color.r, color.g, color.b) });
  context.page.pushOperators(popGraphicsState());
}

/** Draw English; old projects containing Indian scripts must not break a download. */
export const drawText: EditHandler<TextEdit> = async (edit, context) => {
  if (indicLanguage(edit.text)) {
    const warning = `Indian-script text in an edit on page ${context.geometry.pageIndex + 1} was left out of this English PDF. Use Translate to read Indian languages on screen.`;
    if (!context.warnings.includes(warning)) context.warnings.push(warning);
    const text = withoutIndicText(edit.text);
    if (text.trim()) await drawText({ ...edit, text, composition: undefined,
      spans: edit.spans?.map(span => ({ ...span, text: withoutIndicText(span.text) })).filter(span => span.text),
    }, context);
    return;
  }

  if (edit.composition?.version === 1 && edit.composition.text === edit.text) {
    const pieces = positionedComposition(edit.composition);
    if (pieces.every(piece => [piece.x, piece.y, piece.width].every(Number.isFinite) && piece.width >= 0)) {
      const fragments = locateFragments(edit.text, pieces.map(piece => ({ text: piece.text, style: exportStyle(piece.style) })));
      const fallback = fallbackWordRanges(edit.text, fragments, (text, style) => measureTextWithPageFont(text, style, context) !== null);
      for (const [index, piece] of pieces.entries()) {
        if (piece.sourceVisible) continue;
        const source = edit.composition.pieces[index]?.source;
        const glyphs = source?.glyphs;
        let pen = 0;
        const ordinaryAdvances = glyphs?.every(glyph => { const same = Math.abs(glyph.offsetPt - pen) < 1e-8; pen += glyph.widthPt; return same; });
        const segments = glyphs?.length && !ordinaryAdvances ? glyphs.map(glyph => ({ text: glyph.text, x: piece.x + glyph.offsetPt, width: glyph.widthPt })) : [{ text: piece.text, x: piece.x, width: piece.width }];
        for (const segment of segments) {
          const segmentOffset = fragments[index]!.start + (segments.length > 1 ? segments.slice(0, segments.indexOf(segment)).reduce((n, value) => n + value.text.length, 0) : 0);
          // Explicit source glyph origins already include their TJ tightening.
          const segmentStyle = glyphs?.length ? { ...piece.style, fontTrackingEm: undefined } : piece.style;
          const prepared = await prepareText(segment.text, exportStyle(segmentStyle), context, segmentOffset, fallback);
          // Standard-font widthOfTextAtSize includes kerning, whereas drawText
          // emits a plain Tj. Measure the actual emitted advances for this path.
          const advances = prepared.map(item => item.width);
          // Source widths are the PDF's drawn extents, which exclude trailing
          // Tc. New Canvas compositions instead store the full advance. Do not
          // widen a source run to compensate for its final negative spacing.
          const tail = prepared.at(-1);
          const tailSpacing = source && tail && !tail.arrow
            ? (tail.style.fontTrackingEm ?? 0) * tail.style.fontSizePt : 0;
          const actualWidth = advances.reduce((sum, width) => sum + width, 0) - tailSpacing;
          if (actualWidth <= 0) continue;
          const scale = Math.abs(segment.width - actualWidth) < 1e-8 ? 1 : segment.width / actualWidth;
          // Keep the model's measured advance even when the existing font policy
          // selects a substitute. Font selection/reuse rules remain untouched.
          context.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(scale, 0, 0, 1, segment.x, 0),
            setCharacterSpacing(0), setWordSpacing(0), setCharacterSqueeze(100), setTextRenderingMode(TextRenderingMode.Fill));
          let x = 0;
          for (const [preparedIndex, item] of prepared.entries()) {
            drawPrepared(item, x, piece.y, context);
            x += advances[preparedIndex]!;
          }
          context.page.pushOperators(popGraphicsState());
        }
      }
      return;
    }
    context.warnings.push(`Invalid positioned text on page ${context.geometry.pageIndex + 1}; used normal text layout.`);
  }

  const fragments = locateFragments(edit.text, edit.spans?.filter(span => span.text).map(span => ({ text: span.text, style: exportStyle(effectiveTextSpanStyle(edit.style, span)) })) ?? [{ text: edit.text, style: exportStyle(edit.style) }]);
  const fallback = fallbackWordRanges(edit.text, fragments, (text, style) => measureTextWithPageFont(text, style, context) !== null);
  const measured = (await Promise.all(fragments.map(part => prepareText(part.text, part.style, context, part.start, fallback)))).flat();
  let cursorX = alignedTextX(edit,measured.reduce((sum,item)=>sum+item.width,0));
  for (const item of measured) {
    drawPrepared(item, cursorX, edit.rect.y, context);
    cursorX += item.width;
  }
};
