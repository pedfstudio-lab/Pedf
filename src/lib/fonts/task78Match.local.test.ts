import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { extractTextRuns } from '@/lib/pdf/textContent';
import { matchFont, sourceFontWidth } from './fontMatch';
import { loadFontBytes } from './twinFonts';
import { sfntMetrics } from './sfnt';
import { StandardFonts } from 'pdf-lib';
import { drawText } from '@/lib/export/handlers/text';
import type { PageExportContext } from '@/lib/export/context';

describe.runIf(process.env.TASK78_MATCH === '1')('Task 78 implementation corpus', () => {
  it('measures shipped-font words, exports real specimens and preserves source bytes', async () => {
    const baseline = JSON.parse(await readFile('tmp/task78/font-survey.json','utf8')) as { manifest: string[]; supplemental: string[] };
    const rows: unknown[] = [], samples: unknown[] = [];
    const metrics = new Map<string, ReturnType<typeof sfntMetrics>>();
    await mkdir('tmp/task78-match', { recursive:true });
    const files = [...baseline.manifest, ...baseline.supplemental];
    for (const file of files) {
      const original = new Uint8Array(await readFile(file)), hash = createHash('sha256').update(original).digest('hex');
      const doc = await getDocument({data:original.slice(),verbosity:0,fontExtraProperties:true}).promise;
      let words = 0, maxDelta = 0;
      try { for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex++) {
        const runs = await extractTextRuns(await doc.getPage(pageIndex+1),pageIndex);
        for (const run of runs) {
          const match = matchFont(run.style);
          if (!metrics.has(match.file)) metrics.set(match.file, sfntMetrics(await loadFontBytes(match.file)));
          const measure = metrics.get(match.file)!;
          for (const word of run.text.match(/\S+/gu) ?? []) {
            const source = sourceFontWidth(word,run.style), widths = [...word].map(c=>measure.width(c));
            if (!source || widths.some(w=>w===undefined)) continue;
            const width = widths.reduce<number>((sum,w)=>sum+w!,0)*run.style.fontSizePt*match.scale;
            const delta = 100*(width/source-1); words++; maxDelta=Math.max(maxDelta,Math.abs(delta));
            if (Math.abs(delta) > (match.exact ? 0.5 : 1)) samples.push({file,page:pageIndex+1,font:run.style.fontIdentity,word,source,width,delta});
          }
          if (!rows.some(value => (value as {family:string}).family===match.family) && /Carlito|Lato|OpenSans|LeagueSpartan|LiberationSerif/.test(match.family)) {
            const pdf=await PDFDocument.create(), page=pdf.addPage([600,120]);
            const context: PageExportContext={pdf,page,geometry:{pageIndex:0,widthPt:600,heightPt:120,rotation:0,boxOffset:{x:0,y:0}},warnings:[],drawRect:()=>undefined,sampleBackground:()=>undefined};
            // Remove fontRef only for this fallback specimen: complete source
            // words continue to reuse the original font in the actual handler.
            await drawText({id:'font-specimen',kind:'text',pageIndex:0,z:1,rect:{x:20,y:60,w:560,h:run.style.fontSizePt},text:'Quality ZQ 2026',style:{...run.style,fontRef:undefined}},context);
            const bytes=await pdf.save(); await writeFile(`tmp/task78-match/${match.family}.pdf`,bytes);
            const comparison = await PDFDocument.create(), comparisonPage = comparison.addPage([600,120]);
            const comparisonFont = await comparison.embedFont(StandardFonts.Helvetica);
            comparisonPage.drawText('Quality ZQ 2026',{x:20,y:60,font:comparisonFont,size:run.style.fontSizePt});
            const standardBytes = (await comparison.save()).length;
            const fontDict=page.node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
            const names=fontDict.entries().map(([,v])=>pdf.context.lookup(v,PDFDict).lookupMaybe(PDFName.of('BaseFont'),PDFName)?.decodeText());
            expect(names.some(name=>name?.includes(match.family))).toBe(true);
            rows.push({family:match.family,file,page:pageIndex+1,font:run.style.fontIdentity,embedded:names,bytes:bytes.length,standardBytes,deltaBytes:bytes.length-standardBytes,fontBytes:(await loadFontBytes(match.file)).length,warnings:context.warnings});
          }
        }
      }} finally { await doc.destroy(); }
      expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(hash);
      process.stdout.write(`FONT MATCH ${file}: ${words} words, worst ${maxDelta.toFixed(3)}%\n`);
    }
    await writeFile('tmp/task78-match/widths.json',JSON.stringify({files:files.length,specimens:rows,outliers:samples},null,2));
    expect(rows.length).toBeGreaterThanOrEqual(5);
  },1_800_000);
});
