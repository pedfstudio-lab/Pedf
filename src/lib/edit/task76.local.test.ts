import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { countShapeFormUses, planCoveredShapeRemoval } from '@/lib/export/coveredShapes';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { detectBulletListFromRegions, formatBulletEditorText, availableBulletListHeight, type BulletList } from '@/lib/pdf/bulletList';
import { exportPdf } from '@/lib/export/exportPdf';
import { exportPagePreview } from '@/lib/export/exportPagePreview';
import { textPreviewSelection } from '@/lib/pdf/textPreviewSelection';
import type { EditDocument, PdfRect } from '@/lib/export/types';
import { buildBulletListEdits } from './buildTextEdits';

const enabled = process.env.TASK76_REAL === '1' && existsSync('tmp/green-check.pdf');
async function read(bytes:Uint8Array) { return getDocument({data:bytes.slice(),verbosity:0,fontExtraProperties:true}).promise; }
async function data(reader:PDFDocumentProxy,pageNumber:number) {
  const page=await reader.getPage(pageNumber), index=pageNumber-1;
  const [runs,rules,regions]=await Promise.all([extractTextRuns(page,index),detectRuleLines(page,index),detectPageGraphicRegions(page,index)]);
  const blocks=groupRunsIntoBlocks(runs,{ruleLines:rules,markers:[...regions.imageRegions,...regions.shapeMarkerRegions]});
  const lists=blocks.map(block=>detectBulletListFromRegions(block,regions.imageRegions,regions.shapeMarkerRegions)).filter(list=>list!==null);
  return {page,blocks,lists,regions};
}
async function pages(reader:PDFDocumentProxy):Promise<EditDocument['pages']> {
  return Promise.all(Array.from({length:reader.numPages},async(_,pageIndex)=>{ const page=await reader.getPage(pageIndex+1), [x=0,y=0,right=0,top=0]=page.view;
    return {pageIndex,widthPt:right-x,heightPt:top-y,rotation:page.rotate as 0|90|180|270,boxOffset:{x,y}}; }));
}
function editList(list:BulletList,available:number,add=false,move=0) {
  const texts=list.items.map((item,index)=>index===0?item.text.replace(/\S/u,c=>c.toLowerCase()===c?c.toUpperCase():c.toLowerCase()):item.text);
  if(add)texts.push('New item');
  const next={text:formatBulletEditorText(texts,list.items.map(item=>item.markerSymbol??'•')),style:list.block.style,width:list.coverRect.w,height:list.coverRect.h,dx:move,dy:0};
  const built=buildBulletListEdits(list,next,texts.map((text,index)=>({text,lines:index<list.items.length?list.items[index]!.lines.map((line,i)=>index===0&&i===0?line.text.replace(/\S/u,c=>c.toLowerCase()===c?c.toUpperCase():c.toLowerCase()):line.text):[text]})),1,available);
  return {built,texts};
}
function same(a:PdfRect,b:PdfRect){ return Math.abs(a.x-b.x)<0.01&&Math.abs(a.y-b.y)<0.01&&Math.abs(a.w-b.w)<0.01&&Math.abs(a.h-b.h)<0.01; }
describe.runIf(enabled)('Task 76 actual marker removal and symbol round trips',()=>{
  it('matches all 295 measured paths, including all 104 Form markers, without cutting any larger drawing',{timeout:120_000},async()=>{
    const measured=JSON.parse(await readFile('tmp/pdfs/task76-change0.json','utf8')) as {corpus:string[];drawnItems:{file:string;page:number;rect:PdfRect}[]};
    const targets=measured.drawnItems.filter(item=>measured.corpus.includes(item.file)),files=[...new Set(targets.map(item=>item.file))];
    const rows:{file:string;page:number;expected:number;removed:number;unmatched:number}[]=[];
    for(const file of files){
      const pdf=await PDFDocument.load(await readFile(file)),uses=countShapeFormUses(pdf);
      for(const page of [...new Set(targets.filter(item=>item.file===file).map(item=>item.page))]){
        const items=targets.filter(item=>item.file===file&&item.page===page);
        const plan=planCoveredShapeRemoval(pdf,page-1,items.map(item=>({rect:item.rect,replacesShapes:[{rect:item.rect}]})),uses[page-1]!);
        rows.push({file,page,expected:items.length,removed:plan.removedShapes,unmatched:plan.unmatchedShapes});
        expect(plan.removedShapes,`${file} p${page}`).toBe(items.length);expect(plan.unmatchedShapes).toBe(0);
      }
    }
    expect(rows.reduce((sum,row)=>sum+row.removed,0)).toBe(295);
    await writeFile('tmp/pdfs/task76-corpus-removal.json',JSON.stringify(rows,null,2));
  });
  it('removes all 31 NMAT original drawn markers; preview agrees; fitting new items have exactly one marker', {timeout:120_000},async()=>{
    const originalBytes=new Uint8Array(await readFile('tmp/nmat-check.pdf')), reader=await read(originalBytes), geometry=await pages(reader);
    let removed=0, lists=0, fittingAdds=0;
    try {
      for(let p=1;p<=reader.numPages;p++){
        const before=await data(reader,p);
        for(const [index,list] of before.lists.entries()){
          lists++;
          const available=availableBulletListHeight(list,before.blocks,before.page.view[1]??0);
          const {built}=editList(list,available); expect(built.overflow).toBe(false);
          const result=await exportPdf({originalBytes,pages:geometry,edits:[...built.covers,...built.texts]}, {reader});
          process.stdout.write(`NMAT p${p} list${index+1}: ${JSON.stringify({redaction:result.redaction,warnings:result.warnings})}\n`);
          expect(result.redaction.removedShapes,`NMAT p${p} list${index+1}`).toBe(list.items.length);
          expect(result.redaction.unmatchedShapes).toBe(0); removed+=result.redaction.removedShapes!;
          const after=await read(result.bytes);
          try {
            const reopened=await data(after,p), content=await reopened.page.getTextContent();
            expect(content.items.flatMap(i=>'str'in i?[i.str]:[]).filter(s=>s==='•')).toHaveLength(list.items.length);
            for(const item of list.items) expect(reopened.regions.shapeMarkerRegions.some(marker=>same(marker.rect,item.markerRect))).toBe(false);
          }finally{await after.destroy();}
          const selection=textPreviewSelection(list.block,undefined,list);
          const preview=await exportPagePreview({document:{originalBytes,pages:geometry,edits:[]},pageIndex:p-1,selection});
          expect(preview.clean,JSON.stringify(preview.warnings)).toBe(true);
          const added=editList(list,available,true);
          if(!added.built.overflow){
            fittingAdds++;
            const output=await exportPdf({originalBytes,pages:geometry,edits:[...added.built.covers,...added.built.texts]},{reader});
            expect(output.redaction.removedShapes).toBe(list.items.length);
          }
          if(p===1&&index===0)await writeFile('tmp/pdfs/task76-nmat-fixed.pdf',result.bytes);
        }
      }
      expect(lists).toBe(8);expect(removed).toBe(31);expect(fittingAdds).toBe(4);
    }finally{await reader.destroy();}
  });
  it('opens every Green arrow box as a list, retains arrows and exports/reopens all four boxes', {timeout:120_000},async()=>{
    const originalBytes=new Uint8Array(await readFile('tmp/green-check.pdf')), reader=await read(originalBytes), geometry=await pages(reader);
    let boxes=0, arrows=0;
    try{
      for(const p of [7,8,16]){
        const before=await data(reader,p), targets=before.lists.filter(list=>list.items.some(item=>item.markerSymbol==='➢'));
        process.stdout.write(`GREEN p${p}: ${targets.length} lists; marker candidates: ${JSON.stringify(before.blocks.filter(b=>b.text.includes('\uF0D8')).map(b=>b.lines.filter(l=>l.text.includes('\uF0D8')).map(l=>l.runs.map(r=>({text:r.text,x:r.rect.x,w:r.rect.w,size:r.style.fontSizePt})))))}\n`);
        expect(targets.length).toBe(p===8?2:1);
        for(const list of targets){
          boxes++;arrows+=list.items.length;
          expect(list.items.every(item=>item.markerSymbol==='➢')).toBe(true);
          const {built}=editList(list,availableBulletListHeight(list,before.blocks,before.page.view[1]??0));
          expect(built.overflow).toBe(false);
          expect(built.texts.filter(edit=>edit.text==='➢')).toHaveLength(list.items.length);
          const result=await exportPdf({originalBytes,pages:geometry,edits:[...built.covers,...built.texts]},{reader});
          expect(result.warnings).toEqual([]);
          const after=await read(result.bytes);
          try{
            const reopened=await data(after,p), content=await reopened.page.getTextContent();
            expect(content.items.flatMap(item=>'str'in item?[item.str]:[]).filter(text=>text==='➢')).toHaveLength(list.items.length);
            const edited=reopened.lists.find(candidate=>candidate.items.some(item=>item.text.startsWith(list.items[0]!.text.slice(0,1).toLowerCase())||item.text.startsWith(list.items[0]!.text.slice(0,1).toUpperCase())));
            expect(edited,`Green p${p} export must still detect its list`).toBeDefined();
            expect(edited!.items.every(item=>item.markerSymbol==='➢')).toBe(true);
          }finally{await after.destroy();}
          if(p===7)await writeFile('tmp/pdfs/task76-green-fixed.pdf',result.bytes);
        }
      }
      expect(boxes).toBe(4);expect(arrows).toBe(15);
    }finally{await reader.destroy();}
  });
  it('moves and adds to the vector control: file has five bullets, no old dot paths, and old dot pixels are clean', {timeout:30_000},async()=>{
    const originalBytes=new Uint8Array(await readFile('tmp/grouping-probe/bullets-vector-test.pdf')), reader=await read(originalBytes), geometry=await pages(reader);
    try{
      const before=await data(reader,1),list=before.lists[0]!;
      const {built}=editList(list,availableBulletListHeight(list,before.blocks,0),true,60);expect(built.overflow).toBe(false);
      const result=await exportPdf({originalBytes,pages:geometry,edits:[...built.covers,...built.texts]},{reader});
      expect(result.redaction.removedShapes).toBe(4);
      const after=await getDocument({data:result.bytes.slice(),verbosity:0,standardFontDataUrl:resolve('node_modules/pdfjs-dist/standard_fonts')+'/'}).promise;
      try{
        const page=await after.getPage(1), viewport=page.getViewport({scale:4}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height)),ctx=canvas.getContext('2d');
        await page.render({canvasContext:ctx as unknown as CanvasRenderingContext2D,viewport}).promise;
        const content=await page.getTextContent();expect(content.items.filter(item=>'str'in item&&item.str==='•')).toHaveLength(5);
        for(const item of list.items){
          const [left,top]=viewport.convertToViewportPoint(item.markerRect.x,item.markerRect.y+item.markerRect.h),pixels=ctx.getImageData(Math.ceil(left),Math.ceil(top),Math.max(1,Math.floor(item.markerRect.w*4)),Math.max(1,Math.floor(item.markerRect.h*4))).data;
          for(let i=0;i<pixels.length;i+=4)expect(Math.min(pixels[i]!,pixels[i+1]!,pixels[i+2]!)).toBeGreaterThan(245);
        }
        await writeFile('tmp/pdfs/task76-vector-fixed.png',canvas.toBuffer('image/png'));
      }finally{await after.destroy();}
      await writeFile('tmp/pdfs/task76-vector-fixed.pdf',result.bytes);
    }finally{await reader.destroy();}
  });
});
