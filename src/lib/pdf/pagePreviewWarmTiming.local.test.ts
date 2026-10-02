import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { exportPagePreview, PagePreviewSource } from '@/lib/export/exportPagePreview';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';
import { textPreviewSelection } from './textPreviewSelection';
import { PagePreviewController } from './pagePreviewController';
const files=['public/samples/GOA 2026.pdf',"tmp/paragraphs/Bhutan December'26.pdf"];
const enabled=process.env.TASK74_WARM_TIMING==='1'&&files.every(existsSync);
const standardFontDataUrl=resolve('node_modules/pdfjs-dist/standard_fonts')+'/';
describe.skipIf(!enabled)('warm preview timing (Node proxy, not browser input latency)',()=>{
  it('measures page-shared warming and completed hover-cache hits separately',async()=>{
    const measurements=[];
    for(const file of files) {
      const bytes=new Uint8Array(await readFile(file));
      const source=new PagePreviewSource(bytes);const {reader}=await source.prepare(0);
      try {
        const page=await reader.getPage(1),[x=0,y=0,right=0,top=0]=page.view;
        const target=groupRunsIntoBlocks(await extractTextRuns(page,0)).find((block)=>block.text.trim().length>3)!;
        const selection=textPreviewSelection(target);
        const document={originalBytes:bytes,pages:[{pageIndex:0,widthPt:right-x,heightPt:top-y,rotation:page.rotate as 0,boxOffset:{x,y}}],edits:[]};
        for(const zoom of [.5,1,2]) {
          const cache=new PagePreviewController<HTMLCanvasElement>(2);
          let rewriteMs=0,renderMs=0;
          const start=performance.now();
          await cache.warm('selection',async()=>{
            const result=await exportPagePreview({document,pageIndex:0,selection},source);
            expect(result.clean).toBe(true);rewriteMs=performance.now()-start;
            const loading=await getDocument({data:result.bytes.slice(),standardFontDataUrl,verbosity:0}).promise;
            try {
              const preview=await loading.getPage(1),viewport=preview.getViewport({scale:zoom});
              const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
              await preview.render({canvasContext:canvas.getContext('2d') as unknown as CanvasRenderingContext2D,viewport}).promise;
              renderMs=performance.now()-start-rewriteMs;
              return canvas as unknown as HTMLCanvasElement;
            } finally {await loading.destroy();}
          });
          const activation=performance.now();let accepted=false;
          await cache.request('selection',async()=>{throw new Error('A warm hit must not rebuild');},()=>{accepted=true;},()=>undefined);
          expect(accepted).toBe(true);
          const row={file,zoom,rewriteMs,renderMs,pageSharedWarmTotalMs:rewriteMs+renderMs,completedHoverHitMs:performance.now()-activation};
          measurements.push(row);process.stdout.write(`PREVIEW WARM ${JSON.stringify(row)}\n`);cache.clear();
        }
      } finally {source.dispose();}
    }
    await writeFile('tmp/5b-warm-timing.json',JSON.stringify(measurements,null,2));
  },180_000);
});
