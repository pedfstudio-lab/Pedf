import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as fontkitModule from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import { subsetSafeSfnt } from './subsetSafeSfnt';
import { resolveEnglishFont } from '@/lib/export/englishFont';
const kit = (fontkitModule as unknown as { default?: typeof fontkitModule }).default ?? fontkitModule;

describe('fontkit short-loca compatibility', () => {
  it.each(['Regular','Bold','Italic','BoldItalic'])('preserves every Carlito %s Latin outline and advance in a subset', async variant => {
    const bytes = new Uint8Array(await readFile(`public/fonts/carlito/Carlito-${variant}.ttf`));
    const original = bytes.slice(), aligned = subsetSafeSfnt(bytes);
    expect(bytes).toEqual(original);
    const source = kit.create(bytes), prepared = kit.create(aligned), subset = prepared.createSubset();
    const glyphs = prepared.glyphsForString(Array.from({length:95},(_,i)=>String.fromCharCode(i+32)).join(''));
    const ids = glyphs.map(glyph => subset.includeGlyph(glyph));
    const output = await new Promise<Uint8Array>(resolve => {
      const chunks: Uint8Array[] = [];
      subset.encodeStream().on('data', data => { chunks.push(data); }).on('end', () => resolve(Buffer.concat(chunks)));
    });
    const decoded = kit.create(output);
    glyphs.forEach((glyph, i) => {
      const before = source.getGlyph(glyph.id), after = decoded.getGlyph(ids[i]!);
      expect(after.path.toSVG(), `glyph ${glyph.id}`).toBe(before.path.toSVG());
      expect(after.advanceWidth).toBe(before.advanceWidth);
    });
  });
  it('leaves already-aligned font files and non-font input unchanged', async () => {
    const bytes = new Uint8Array(await readFile('public/fonts/liberation/LiberationSans-Regular.ttf'));
    expect(subsetSafeSfnt(bytes)).toBe(bytes);
    const invalid = new Uint8Array([1,2,3]); expect(subsetSafeSfnt(invalid)).toBe(invalid);
  });
  it.runIf(process.env.TASK78_MATCH === '1')('exports all four Carlito styles for independent pixel review', async () => {
    for (const [variant,bold,italic] of [['Regular',false,false],['Bold',true,false],['Italic',false,true],['BoldItalic',true,true]] as const) {
      const pdf = await PDFDocument.create(), page = pdf.addPage([600,120]);
      const context = {pdf,page,geometry:{pageIndex:0,widthPt:600,heightPt:120,rotation:0 as const,boxOffset:{x:0,y:0}},warnings:[],drawRect:()=>undefined,sampleBackground:()=>undefined};
      const font = await resolveEnglishFont({fontName:'Calibri',fontSizePt:24,bold,italic,color:{r:0,g:0,b:0}},context);
      page.drawText('Quality ZQ 2026',{x:20,y:60,font,size:24,color:rgb(0,0,0)});
      await writeFile(`tmp/task78-match/Carlito-${variant}-fixed.pdf`,await pdf.save());
    }
  });
});
