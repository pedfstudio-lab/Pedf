import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { sourceParagraphs } from '@/lib/edit/paragraphSeed';
import { sourceSpansForTextBlock, effectiveTextSpanStyle, effectiveTextSpans } from '@/lib/edit/richText';
import { paragraphPresentation } from '@/lib/edit/paragraphPresentation';
import { visibleWordSpacingFloor } from '@/lib/edit/justifiedLayout';
import { wrapTextParagraphs } from '@/lib/edit/paragraphLayout';
import { buildTextBlockEdits, type NextTextEdit } from '@/lib/edit/buildTextEdits';
import { matchFont, sourceFontWidth } from './fontMatch';
import { loadFontBytes } from './twinFonts';
import { sfntMetrics } from './sfnt';
import type { TextStyle } from '@/lib/export/types';
import type { MeasurePiece } from '@/lib/edit/lineComposition';
describe.runIf(process.env.TASK78_MATCH==='1')('Task 78 unchanged real paragraph rows',()=>{
  it('keeps Healing p3 source rows without squeezing away spaces',async()=>{
    const doc=await getDocument({data:new Uint8Array(await readFile('tmp/compress-tests/healing.pdf')),fontExtraProperties:true,verbosity:0}).promise;
    try {
      const page=await doc.getPage(3),runs=await extractTextRuns(page,2),ruleLines=await detectRuleLines(page,2),regions=await detectPageGraphicRegions(page,2);
      const block=groupRunsIntoBlocks(runs,{ruleLines,markers:[...regions.imageRegions,...regions.shapeMarkerRegions]}).find(b=>b.text.startsWith('It’s not about fixing'))!;
      expect(block.lines).toHaveLength(5);
      expect(block.style.fontTrackingEm).toBeLessThan(-0.03);
      expect(block.style.fontTrackingEm).toBeGreaterThan(-0.045);
      const metrics=new Map<string,ReturnType<typeof sfntMetrics>>();
      for(const run of block.lines.flatMap(line=>line.runs)) {
        const match=matchFont(run.style);if(!metrics.has(match.file))metrics.set(match.file,sfntMetrics(await loadFontBytes(match.file)));
      }
      const measure:MeasurePiece=(text,style)=>[...text].reduce((n,c)=>n+(metrics.get(matchFont(style).file)!.width(c)??0),0)*style.fontSizePt*matchFont(style).scale+[...text].length*(style.fontTrackingEm??0)*style.fontSizePt;
      const seed=sourceParagraphs(block);
      for(const zoom of [1,2]) {
        const presentation=paragraphPresentation(block,seed.text,block.style,zoom,measure);
        expect(presentation.fallbacks).toEqual([undefined]);
        expect(presentation.html.match(/data-pdf-source-row=/g)).toHaveLength(5);
      }
      for(const line of block.lines) {
        const spans=effectiveTextSpans(line.text,line.style,sourceSpansForTextBlock({...block,text:line.text,lines:[line]},line.text,true));
        const natural=spans.reduce((n,s)=>n+measure(s.text,effectiveTextSpanStyle(line.style,s)),0);
        const spacing=(line.rect.w-natural)/(line.text.match(/\s/gu)??[]).length;
        expect(spacing).toBeGreaterThanOrEqual(visibleWordSpacingFloor(spans,line.style,(word,span)=>measure(word,effectiveTextSpanStyle(line.style,span))));
      }
    } finally {await doc.destroy();}
  },120000);
  it('keeps original Ladakh rows after a final word and records the median-rule tolerance',async()=>{
    const doc=await getDocument({data:new Uint8Array(await readFile('tmp/compress-tests/ladakh-original.pdf')),fontExtraProperties:true,verbosity:0}).promise;
    try{
      const page=await doc.getPage(2),runs=await extractTextRuns(page,1),ruleLines=await detectRuleLines(page,1),regions=await detectPageGraphicRegions(page,1);
      const block=groupRunsIntoBlocks(runs,{ruleLines,markers:[...regions.imageRegions,...regions.shapeMarkerRegions]}).find(b=>b.text.startsWith('Ladakh, for us'))!;
      expect(block).toBeDefined();
      const seed=sourceParagraphs(block),spans=sourceSpansForTextBlock(block,seed.text,true)??[{text:seed.text,bold:block.style.bold,italic:block.style.italic}];
      const last=effectiveTextSpanStyle(block.style,spans.at(-1)!);
      const metrics=new Map<string,ReturnType<typeof sfntMetrics>>();
      for(const style of [block.style,...spans.map(span=>effectiveTextSpanStyle(block.style,span))]){
        const match=matchFont(style);if(!metrics.has(match.file))metrics.set(match.file,sfntMetrics(await loadFontBytes(match.file)));
      }
      const nominal=(text:string,style:TextStyle)=>[...text].reduce((sum,c)=>sum+(metrics.get(matchFont(style).file)!.width(c)??0),0)*style.fontSizePt*matchFont(style).scale;
      const measure:MeasurePiece=(text,style,source)=>{
        const width=nominal(text,style)+[...text].length*(style.fontTrackingEm??0)*style.fontSizePt;
        if(source?.advanceTrackingPt!==undefined)return width+[...text].length*source.advanceTrackingPt;
        if(source?.advanceScale!==undefined)return width*source.advanceScale;
        if(!source||(source.source&&!source.source.glyphs?.length))return width;
        const intrinsic=source.source?.glyphs?.reduce((n,g)=>n+g.widthPt,0)??source.widthPt;
        const original=nominal(source.text,style)+[...source.text].length*(style.fontTrackingEm??0)*style.fontSizePt;return original>0?width*intrinsic/original:width;
      };
      const next:NextTextEdit={text:seed.text+' wonderful',style:block.style,spans:[...spans,{text:' wonderful',...last}],paragraphs:seed.layouts,width:block.rect.w,height:block.rect.h,dx:0,dy:0,align:block.align,measurePiece:measure,preserveSourceWrapping:true};
      const wrapped=wrapTextParagraphs(next,(text,span)=>measure(text,effectiveTextSpanStyle(next.style,span)),block);
      const built=buildTextBlockEdits(block,next,wrapped,1);
      const unchanged=built.texts.filter(edit=>block.lines.some(line=>line.text===edit.text&&Math.abs(line.baselineY-edit.rect.y)<1e-8));
      const word='wonderful',sourceWidth=sourceFontWidth(word,last),matchedWidth=nominal(word,last);
      // Independent drawn-width reference: the PDF's word runs include n-1
      // internal TJ gaps; the screen/PDF advance includes a final character gap.
      const gaps=runs.filter(run=>run.style.fontIdentity===last.fontIdentity && !/\s/u.test(run.text) && [...run.text].length>=4).flatMap(run=>{
        const own=sourceFontWidth(run.text,run.style);
        return own===undefined?[]:[(run.rect.w-own)/(([...run.text].length-1)*run.style.fontSizePt)];
      }).sort((a,b)=>a-b);
      expect(gaps.length).toBeGreaterThan(2);
      const drawnGapEm=gaps[Math.floor(gaps.length/2)]!, sourceDrawnWidth=sourceWidth!+([...word].length-1)*drawnGapEm*last.fontSizePt;
      const matchedDrawnWidth=matchedWidth+([...word].length-1)*(last.fontTrackingEm??0)*last.fontSizePt;
      const drawnDeltaPercent=100*(matchedDrawnWidth/sourceDrawnWidth-1);
      await mkdir('tmp/task78-match',{recursive:true});
      await writeFile('tmp/task78-match/ladakh-flow.json',JSON.stringify({sourceLines:block.lines.length,editedLines:built.texts.length,unchangedLines:unchanged.length,keptPieces:built.texts.flatMap(t=>t.composition?.pieces??[]).filter(p=>p.sourceVisible).length,
        word,sourceWidth,matchedWidth,medianDeltaPercent:sourceWidth?100*(matchedWidth/sourceWidth-1):null,
        trackingEm:last.fontTrackingEm,drawnGapEm,sourceDrawnWidth,matchedDrawnWidth,drawnDeltaPercent,
        lines:built.texts.map(edit=>({text:edit.text,y:edit.rect.y,pieces:edit.composition?.pieces}))},null,2));
      expect(unchanged.length).toBeGreaterThan(0);
      expect(Math.abs(drawnDeltaPercent)).toBeLessThanOrEqual(1);
      for(const edit of unchanged)expect(edit.composition?.pieces.every(piece=>piece.sourceVisible)).toBe(true);
    }finally{await doc.destroy();}
  },120000);
});
