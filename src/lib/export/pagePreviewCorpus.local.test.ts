import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createCanvas } from '@napi-rs/canvas';
import { buildTextBlockEdits } from '@/lib/edit/buildTextEdits';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { textPreviewSelection } from '@/lib/pdf/textPreviewSelection';
import { detectBulletListFromRegions } from '@/lib/pdf/bulletList';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { exportPagePreview, PagePreviewSource } from './exportPagePreview';
import { exportPdf } from './exportPdf';
import type { EditDocument } from './types';

const baselinePath='tmp/tables/baseline.json';
const enabled=process.env.TASK74_PREVIEW==='1' && existsSync(baselinePath);
const standardFontDataUrl=resolve('node_modules/pdfjs-dist/standard_fonts')+'/';
async function geometry(reader:PDFDocumentProxy):Promise<EditDocument['pages']> {
  return Promise.all(Array.from({length:reader.numPages},async(_,pageIndex)=>{
    const page=await reader.getPage(pageIndex+1),[x=0,y=0,right=0,top=0]=page.view;
    return {pageIndex,widthPt:right-x,heightPt:top-y,rotation:page.rotate as 0|90|180|270,boxOffset:{x,y}};
  }));
}
async function pixels(bytes:Uint8Array,pageNumber:number) {
  const reader=await getDocument({data:bytes.slice(),standardFontDataUrl,verbosity:0}).promise;
  try {
    const page=await reader.getPage(pageNumber),viewport=page.getViewport({scale:1});
    const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    const context=canvas.getContext('2d');
    await page.render({canvasContext:context as unknown as CanvasRenderingContext2D,viewport}).promise;
    return Buffer.from(context.getImageData(0,0,canvas.width,canvas.height).data);
  } finally {await reader.destroy();}
}

describe.skipIf(!enabled)('Task 74 real page preview corpus',()=>{
  it('accounts for every selection and checks clean editing and committed pixels against full export',async()=>{
    const baseline=JSON.parse(await readFile(baselinePath,'utf8')) as {files:Record<string,unknown>};
    const cases:{file:string;pageNumber?:number;find?:string;list?:boolean}[]=Object.keys(baseline.files).sort().map((file)=>({file}));
    cases.push(
      {file:"tmp/paragraphs/Bhutan December'26.pdf",pageNumber:1,find:'BHUTAN'},
      {file:'tmp/tables/Firgun_QT-H4SNASRX_SriLanka.pdf',pageNumber:1,find:'Daun Lebar'},
      {file:'tmp/paragraphs/FIRGUN SRI 1.pdf',pageNumber:4,find:'PER PERSON'},
      {file:'tmp/bullets/RAHUL_RAJPUT_RESUME.pdf',pageNumber:1,list:true},
    );
    const report:{file:string;page:number;label:string;clean:boolean;reason?:string;parity?:boolean;warmMs?:number}[]=[];
    for (const entry of cases) {
      expect(existsSync(entry.file),entry.file).toBe(true);
      const originalBytes=new Uint8Array(await readFile(entry.file));
      const reader=await getDocument({data:originalBytes.slice(),fontExtraProperties:true,verbosity:0}).promise;
      const source=new PagePreviewSource(originalBytes,reader);
      try {
        const pages=await geometry(reader);
        let found=false;
        for(let pageNumber=entry.pageNumber??1;pageNumber<=reader.numPages;pageNumber++) {
          const page=await reader.getPage(pageNumber),ruleLines=await detectRuleLines(page,pageNumber-1);
          const blocks=groupRunsIntoBlocks(await extractTextRuns(page,pageNumber-1),{ruleLines});
          const regions=entry.list?await detectPageGraphicRegions(page,pageNumber-1):undefined;
          const list=entry.list?blocks.map((block)=>detectBulletListFromRegions(block,regions!.imageRegions,regions!.shapeMarkerRegions)).find((list)=>list!==null):undefined;
          const target=list?.block??blocks.find((block)=>entry.find
            ? block.text.replace(/\s+/g,'').toUpperCase().includes(entry.find.replace(/\s+/g,'').toUpperCase())
            : block.text.trim().length>3);
          if(!target) {if(entry.pageNumber) break;continue;}
          found=true;
          const selection=textPreviewSelection(target,undefined,list??undefined);
          const document:EditDocument={originalBytes,pages,edits:[]};
          const snapshot=JSON.stringify({pages:document.pages,edits:document.edits});
          const sourceHash=createHash('sha256').update(originalBytes).digest('hex');
          await source.prepare(pageNumber-1);
          const start=performance.now();
          const clean=await exportPagePreview({document,pageIndex:pageNumber-1,selection},source);
          const item={file:entry.file,page:pageNumber,label:target.text.slice(0,70),clean:clean.clean,reason:clean.reason,warmMs:performance.now()-start,parity:undefined as boolean|undefined};
          if(clean.clean) {
            const full=await exportPdf({...document,edits:[...selection.transientEdits]});
            expect(Buffer.compare(await pixels(clean.bytes,1),await pixels(full.bytes,pageNumber)),entry.file+' editing pixels').toBe(0);
            // A committed preview and re-edit omission use the same existing cover group.
            const built=buildTextBlockEdits(target,{text:'PREVIEW CHECK',style:target.style,width:target.rect.w,height:target.rect.h,dx:0,dy:0},['PREVIEW CHECK'],10);
            const committed={...document,edits:[...built.covers,...built.texts]};
            const preview=await exportPagePreview({document:committed,pageIndex:pageNumber-1},source);
            const exported=await exportPdf(committed);
            expect(Buffer.compare(await pixels(preview.bytes,1),await pixels(exported.bytes,pageNumber)),entry.file+' committed pixels').toBe(0);
            const reedit=await exportPagePreview({document:committed,pageIndex:pageNumber-1,selection:textPreviewSelection(target,built)},source);
            if(reedit.clean) {
              const omitted=await exportPdf({...committed,edits:[...built.covers]});
              expect(Buffer.compare(await pixels(reedit.bytes,1),await pixels(omitted.bytes,pageNumber)),entry.file+' re-edit pixels').toBe(0);
            } else report.push({file:entry.file,page:pageNumber,label:'re-edit',clean:false,reason:reedit.reason});
            item.parity=true;
          } else expect(clean.reason,entry.file+' fallback reason').toBeTruthy();
          expect(JSON.stringify({pages:document.pages,edits:document.edits}),entry.file+' input mutation').toBe(snapshot);
          expect(createHash('sha256').update(originalBytes).digest('hex'),entry.file+' source mutation').toBe(sourceHash);
          report.push(item);process.stdout.write(`TASK74 PREVIEW ${JSON.stringify(item)}\n`);
          await writeFile('tmp/5b-preview-corpus.json',JSON.stringify(report,null,2));break;
        }
        if(!found) report.push({file:entry.file,page:entry.pageNumber??1,label:'no selectable target',clean:false,reason:'No matching extracted text unit.'});
        if(entry.find||entry.list) expect(found,entry.file+' required target').toBe(true);
      } finally {source.dispose();await reader.destroy();}
    }
    await writeFile('tmp/5b-preview-corpus.json',JSON.stringify(report,null,2));
    const successes=report.filter((row)=>row.clean).length;
    process.stdout.write(`TASK74 PREVIEW TOTAL ${successes} clean / ${report.length} selections; ${report.length-successes} reasoned fallbacks\n`);
    expect(successes).toBeGreaterThan(0);
    expect(report.filter((row)=>!row.clean&&!row.reason)).toEqual([]);
  },600_000);
});
