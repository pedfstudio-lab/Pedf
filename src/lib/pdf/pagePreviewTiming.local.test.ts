import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { writePageEdits } from '@/lib/export/exportPdf';
import { extractTextRuns } from './textContent';

const files = ['public/samples/GOA 2026.pdf', "tmp/paragraphs/Bhutan December'26.pdf"];
const enabled = process.env.TASK74_TIMING === '1' && files.every(existsSync);
const standardFontDataUrl = resolve('node_modules/pdfjs-dist/standard_fonts') + '/';

describe.skipIf(!enabled)('Task 74 preview cost before caching (Node browser proxy)', () => {
  it('separates parse/operators, stream rewrite, render and worker transfer/blocking costs', async () => {
    for (const file of files) {
      const bytes = new Uint8Array(await readFile(file));
      for (const zoom of [0.5, 1, 2]) {
        const start = performance.now();
        const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
        const reader = await getDocument({ data: bytes.slice(), standardFontDataUrl, verbosity: 0 }).promise;
        try {
          const page = await reader.getPage(1);
          const operators = await page.getOperatorList({ annotationMode: 0 });
          await page.getTextContent();
          const parsed = performance.now();
          const runs = await extractTextRuns(page, 0);
          const run = runs.find((entry) => entry.text.trim().length > 3);
          expect(run).toBeDefined();
          expect(operators.fnArray.length).toBeGreaterThan(0);
          const single = await PDFDocument.create();
          const [copied] = await single.copyPages(pdf, [0]);
          single.addPage(copied!);
          const [x=0,y=0,right=0,top=0] = page.view;
          const written = await writePageEdits(single, { originalBytes: bytes, plan: [{id:'source',kind:'source',sourceIndex:0}],
            pages: [{pageIndex:0,widthPt:right-x,heightPt:top-y,rotation:page.rotate as 0,boxOffset:{x,y}}],
            edits: [{id:'remove',kind:'cover',pageIndex:0,z:1,sampleBackground:true,
              rect: { ...run!.rect, y: run!.rect.y - 2, h: run!.rect.h + 4 }, replaces: [{text:run!.text,rect:run!.rect}]}] }, {reader});
          const previewBytes = await single.save();
          const rewritten = performance.now();
          const previewReader = await getDocument({data:previewBytes,standardFontDataUrl,verbosity:0}).promise;
          const previewPage = await previewReader.getPage(1);
          const viewport = previewPage.getViewport({ scale: zoom });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await previewPage.render({ canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport }).promise;
          process.stdout.write(`PREVIEW BASELINE ${file} zoom ${zoom}: parse/operators ${(parsed-start).toFixed(1)} ms; copy/tree/rewrite/save ${(rewritten-parsed).toFixed(1)} ms; reopen/render ${(performance.now()-rewritten).toFixed(1)} ms; matched ${written.redaction.removedItems}\n`);
          await previewReader.destroy();
        } finally { await reader.destroy(); }
      }
      // A Node worker is a feasibility proxy, not a claim about browser event-loop latency.
      const workerCode = `const {parentPort}=require('node:worker_threads'); parentPort.on('message',async ({buffer,parse})=>{const start=performance.now(); try {if(parse){ const {PDFDocument}=await import(${JSON.stringify(pathToFileURL(resolve('node_modules/pdf-lib/cjs/index.js')).href)}); await PDFDocument.load(new Uint8Array(buffer)); const {getDocument}=await import(${JSON.stringify(pathToFileURL(resolve('node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href)});const doc=await getDocument({data:new Uint8Array(buffer).slice(),verbosity:0}).promise;await(await doc.getPage(1)).getOperatorList();await doc.destroy();}parentPort.postMessage({ms:performance.now()-start});}catch(error){parentPort.postMessage({error:String(error)});}});`;
      const worker = new Worker(workerCode, { eval: true });
      try {
        for (const mode of ['clone', 'transfer', 'parse'] as const) {
          const buffer = bytes.slice().buffer;
          const started = performance.now();
          let maxDelay = 0;
          let tick = performance.now();
          const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now-tick-5); tick=now; }, 5);
          const result = await new Promise<{ ms?: number; error?: string }>((resolveResult, reject) => {
            worker.once('message', resolveResult); worker.once('error', reject);
            worker.postMessage({ buffer, parse: mode === 'parse' }, mode === 'clone' ? [] : [buffer]);
          });
          clearInterval(timer);
          expect(result.error).toBeUndefined();
          process.stdout.write(`PREVIEW WORKER ${file} ${mode}: wall ${(performance.now()-started).toFixed(1)} ms; main-thread max delay ${maxDelay.toFixed(1)} ms; worker ${JSON.stringify(result)}\n`);
        }
      } finally { await worker.terminate(); }
    }
  }, 180_000);
});
