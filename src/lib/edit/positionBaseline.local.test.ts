import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OPS, type PDFPageProxy } from 'pdfjs-dist';
import { extractTextRuns, groupRunsIntoBlocks, mergeRunsIntoLines, type TextLine } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { detectBulletListFromRegions } from '@/lib/pdf/bulletList';
import { sourceParagraphs } from './paragraphSeed';
import { exportPdf } from '@/lib/export/exportPdf';

interface RawSpacing {normalSpacePt:number|null;charSpacingPt:number;spaces:{left:string;right:string;gapPt:number;normalSpacePt:number|null;excessPt:number|null}[];unmeasured:number}
function runKey(font:string,text:string,x:number,y:number) {return JSON.stringify([font,text,x.toFixed(4),y.toFixed(4)]);}
async function rawSpacing(page:PDFPageProxy):Promise<Map<string,RawSpacing>> {
  const [content,operators] = await Promise.all([page.getTextContent(),page.getOperatorList()]);
  let state = {font:'',size:1,tc:0,tw:0}; const stack:typeof state[] = [];
  const glyphs:{char:string;font:string;beforeEm:number;tcEm:number;widthEm:number;valid:boolean}[] = [];
  const spaceWidths = new Map<string,number>(); let pendingEm = 0;
  const collect = (entry:unknown) => {
    if (Array.isArray(entry)) {entry.forEach(collect);return;}
    if (typeof entry === 'number') {pendingEm -= entry / 1000;return;}
    if (!entry || typeof entry !== 'object') return;
    const glyph = entry as {unicode?:string;width?:number};
    if (typeof glyph.unicode !== 'string' || typeof glyph.width !== 'number') return;
    const tcEm = state.tc / Math.abs(state.size || 1);
    if (/^\s+$/u.test(glyph.unicode)) {
      if (glyph.unicode === ' ') spaceWidths.set(state.font,glyph.width);
      pendingEm += glyph.width / 1000 + tcEm + state.tw / Math.abs(state.size || 1); return;
    }
    const characters=[...glyph.unicode.normalize('NFKC')];
    characters.forEach((char,index) => glyphs.push({char,font:state.font,beforeEm:index ? 0 : pendingEm,tcEm:index ? 0 : tcEm,widthEm:index ? 0 : glyph.width!/1000,valid:characters.length===1}));
    pendingEm = 0;
  };
  operators.fnArray.forEach((op,index) => {const args=operators.argsArray[index] ?? [];
    if (op===OPS.save || op===OPS.paintFormXObjectBegin) stack.push({...state});
    else if (op===OPS.restore || op===OPS.paintFormXObjectEnd) state=stack.pop() ?? state;
    else if (op===OPS.setFont) state={...state,font:args[0],size:args[1]};
    else if (op===OPS.setCharSpacing) state={...state,tc:args[0]};
    else if (op===OPS.setWordSpacing) state={...state,tw:args[0]};
    else if (op===OPS.nextLineSetSpacingShowText) {state={...state,tw:args[0],tc:args[1]};collect(args.at(-1));return;}
    if ([OPS.showText,OPS.showSpacedText,OPS.nextLineShowText].includes(op)) collect(args[0]);
  });
  let cursor=0, mismatch=false; const result=new Map<string,RawSpacing>();
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const scale=Math.hypot(item.transform[0]!,item.transform[1]!);
    const font=page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : undefined;
    const rawSpace=spaceWidths.get(item.fontName) ?? font?.spaceWidth;
    // Only an ordinary horizontal advance matrix is accepted. Type3 alone
    // isn't a rejection: its measured advances can still be valid. The trace
    // must also reproduce the extracted run width before its gaps are used.
    const matrix=font?.fontMatrix;
    const supported=!font?.vertical && Math.abs(item.transform[1]!)<0.001 && Math.abs(item.transform[2]!)<0.001
      && (!matrix || Math.abs(matrix[0]-0.001)<0.000001);
    const normal=supported && typeof rawSpace==='number' && rawSpace>0 ? rawSpace*scale/1000 : null;
    let previous:typeof glyphs[number]|undefined, whites=0, unmeasured=0; const spaces:RawSpacing['spaces']=[];
    let charSpacingPt=0,predictedEm=0,glyphCount=0;
    for (const char of [...item.str]) {
      if (/\s/u.test(char)) {whites++;continue;}
      const glyph=glyphs[cursor++];
      if (!glyph || glyph.char!==char) mismatch=true;
      if(glyph) {predictedEm+=glyph.widthEm+glyph.tcEm+(glyphCount ? glyph.beforeEm : 0);glyphCount++;}
      if (whites && previous) {
        if (!mismatch && supported && glyph?.valid && previous.valid && glyph.font===item.fontName && previous.font===item.fontName) {
          const gap=(glyph.beforeEm+previous.tcEm)*scale;
          spaces.push({left:previous.char,right:char,gapPt:gap,normalSpacePt:normal,excessPt:normal===null ? null : gap-normal});
        } else unmeasured++;
      }
      whites=0;previous=glyph;if(glyph)charSpacingPt=Math.max(charSpacingPt,Math.abs(glyph.tcEm*scale));
    }
    const actualInteriorSpaces=(item.str.trim().match(/\s+/g) ?? []).length;
    const validated=!mismatch && Math.abs(predictedEm*scale-item.width)<=0.1;
    result.set(runKey(item.fontName,item.str,item.transform[4]!,item.transform[5]!),{normalSpacePt:normal,charSpacingPt,
      spaces:validated ? spaces : [],unmeasured:validated ? unmeasured : actualInteriorSpaces});
  }
  return result;
}
function wordGaps(line: TextLine,raw:ReadonlyMap<string,RawSpacing>) {
  const ordered = [...line.runs].sort((a,b) => a.rect.x - b.rect.x);
  const measured: {left:string;right:string;gapPt:number;normalSpacePt:number|null;excessPt:number|null}[] = [];
  let internalSpaces = 0,unmeasuredInternalSpaces=0,charSpacingPt=0;
  let cursor = 0;
  for (const [index, run] of ordered.entries()) {
    internalSpaces += (run.text.trim().match(/\s+/g) ?? []).length;
    const metric=raw.get(runKey(run.style.fontRef ?? '',run.text,run.rect.x,run.rect.y));
    if(metric) {measured.push(...metric.spaces);unmeasuredInternalSpaces+=metric.unmeasured;charSpacingPt=Math.max(charSpacingPt,metric.charSpacingPt);}
    else unmeasuredInternalSpaces+=(run.text.trim().match(/\s+/g) ?? []).length;
    const next = ordered[index + 1]; if (!next) continue;
    const left = run.text.trim(), right = next.text.trim();
    const start = line.text.indexOf(left,cursor); if (start < cursor) continue;
    cursor = start + left.length;
    const nextStart = line.text.indexOf(right,cursor);
    if (!left || !right || nextStart < cursor || !/\s/.test(line.text.slice(cursor,nextStart))) continue;
    const nextMetric=raw.get(runKey(next.style.fontRef ?? '',next.text,next.rect.x,next.rect.y));
    const normal = nextMetric?.normalSpacePt ?? metric?.normalSpacePt ?? undefined;
    const gap = next.rect.x - (run.rect.x + run.rect.w);
    measured.push({left:left.slice(-24),right:right.slice(0,24),gapPt:gap,normalSpacePt:normal ?? null,excessPt:normal === undefined ? null : gap - normal});
  }
  return {measured,internalSpaces,unmeasuredInternalSpaces,charSpacingPt};
}

describe.runIf(process.env.TASK74_POSITION === '1')('Step 5d Change 0 corpus baseline', () => {
  it('inspects the original heading and paragraph matrices', async()=>{
    const report=[];
    for(const [file,index] of [["tmp/paragraphs/Bhutan December'26.pdf",0],['tmp/compress-tests/ladakh-original.pdf',1]] as const) {
      const document=await getDocument({data:new Uint8Array(await readFile(file)),verbosity:0,fontExtraProperties:true}).promise;
      try {const page=await document.getPage(index+1);await page.getOperatorList();const content=await page.getTextContent(),raw=await rawSpacing(page);
        const items=content.items.filter(item=>'str' in item && (item.str==='BHUTAN' || index===1 && item.transform[5]!>552 && item.transform[5]!<555)).slice(0,8);
        report.push({file,page:index+1,view:page.view,items:items.map(item=>{if(!('str' in item))return {};const font=page.commonObjs.get(item.fontName);
          return {text:item.str,matrix:item.transform,font:item.fontName,width:item.width,fontMatrix:font?.fontMatrix,spaceWidth:font?.spaceWidth,type3:font?.isType3Font,vertical:font?.vertical,
            raw:raw.get(runKey(item.fontName,item.str,item.transform[4]!,item.transform[5]!))};})});
      }finally{await document.destroy();}
    }
    await writeFile('tmp/5d/matrix-probe.json',JSON.stringify(report,null,2));
    process.stdout.write(`POSITION MATRICES ${JSON.stringify(report)}\n`);
  },30_000);
  it('checks untouched exported origins and baselines numerically on all five fixtures',async()=>{
    const cases=[['bhutan',"tmp/paragraphs/Bhutan December'26.pdf",0],['right','tmp/compress-tests/healing.pdf',16],['ladakh','tmp/compress-tests/ladakh-original.pdf',1],['cell','tmp/tables/Firgun_QT-H4SNASRX_SriLanka.pdf',0],['bullet','tmp/bullets/RAHUL_RAJPUT_RESUME.pdf',0]] as const;
    const report=[];
    for(const [name,file,index] of cases){
      const bytes=new Uint8Array(await readFile(file));const document=await getDocument({data:bytes.slice(),verbosity:0,fontExtraProperties:true}).promise;
      try {const page=await document.getPage(index+1),before=await extractTextRuns(page,index);
        const pages=await Promise.all(Array.from({length:document.numPages},async(_,pageIndex)=>{const source=await document.getPage(pageIndex+1);const view=source.getViewport({scale:1,rotation:0}).viewBox;
          return {pageIndex,widthPt:view[2]!-view[0]!,heightPt:view[3]!-view[1]!,rotation:source.rotate as 0|90|180|270,boxOffset:{x:view[0]!,y:view[1]!}};}));
        const exported=await exportPdf({originalBytes:bytes,pages,edits:[]});await writeFile(`tmp/5d/${name}-noop.pdf`,exported.bytes);
        const reader=await getDocument({data:exported.bytes.slice(),verbosity:0,fontExtraProperties:true}).promise;
        try {const after=await extractTextRuns(await reader.getPage(index+1),index);
          expect(after.map(run=>({text:run.text,rect:run.rect}))).toEqual(before.map(run=>({text:run.text,rect:run.rect})));
          report.push({name,file,page:index+1,runs:before.length,xMovementPt:0,baselineMovementPt:0,exactNumbers:true});
        }finally{await reader.destroy();}
      }finally{await document.destroy();}
    }
    await writeFile('tmp/5d/noop-export.json',JSON.stringify(report,null,2));process.stdout.write(`POSITION NOOP EXPORT ${JSON.stringify(report)}\n`);
  },90_000);
  it('freezes source strings and surveys justified candidates without changing the app', {timeout:1_800_000}, async () => {
    const baseline = JSON.parse(await readFile('tmp/tables/baseline.json','utf8')) as {files:Record<string,{pages:{pageIndex:number;lines:string[]}[]}>};
    const files = [...new Set([...Object.keys(baseline.files), 'tmp/compress-tests/ladakh-original.pdf'])];
    expect(files).toHaveLength(45);
    const snapshot: Record<string, {pageIndex:number;lines:string[]}[]> = {};
    const candidates: unknown[] = [], nearMisses: unknown[] = [], alignmentExamples: unknown[] = [];
    let pageCount = 0, lineCount = 0, historicalChangedPages = 0, leftMultiline = 0, bulletBoxes = 0;
    const byFile: Record<string,{candidates:number;nearMisses:number}> = {};
    await mkdir('tmp/5d',{recursive:true});
    for (const file of files) {
      expect(existsSync(file),file).toBe(true);
      const document = await getDocument({data:new Uint8Array(await readFile(file)),verbosity:0,fontExtraProperties:true}).promise;
      snapshot[file] = []; byFile[file] = {candidates:0,nearMisses:0};
      try {for (const entry of baseline.files[file]?.pages ?? Array.from({length:document.numPages},(_,pageIndex) => ({pageIndex,lines:[]}))) {
        const page = await document.getPage(entry.pageIndex + 1);
        const [runs,ruleLines,regions,raw] = await Promise.all([extractTextRuns(page,entry.pageIndex),detectRuleLines(page,entry.pageIndex),detectPageGraphicRegions(page,entry.pageIndex),rawSpacing(page)]);
        const options = {ruleLines,markers:[...regions.imageRegions,...regions.shapeMarkerRegions]};
        const lines = mergeRunsIntoLines(runs,options).map(line => line.text);
        snapshot[file].push({pageIndex:entry.pageIndex,lines}); pageCount++; lineCount += lines.length;
        if (JSON.stringify(lines) !== JSON.stringify(entry.lines)) historicalChangedPages++;
        for (const [blockIndex,block] of groupRunsIntoBlocks(runs,options).entries()) {
          if (block.align === 'right' && alignmentExamples.length < 20) alignmentExamples.push({file,page:entry.pageIndex + 1,text:block.text,rect:block.rect});
          if (block.lines.length < 2 || (block.align ?? 'left') !== 'left') continue;
          leftMultiline++;
          if (detectBulletListFromRegions(block,regions.imageRegions,regions.shapeMarkerRegions)) {bulletBoxes++;continue;}
          const groups = sourceParagraphs(block).lines;
          const full = groups.flatMap(group => group.slice(0,-1));
          if (!full.length) continue;
          const edges = full.map(line => line.rect.x + line.rect.w);
          const widestRight = Math.max(...block.lines.map(line => line.rect.x + line.rect.w));
          const spread = widestRight - Math.min(...edges);
          if (spread > 2) continue;
          const measurements = block.lines.map(line => ({text:line.text,x:line.rect.x,baseline:line.baselineY,right:line.rect.x+line.rect.w,...wordGaps(line,raw)}));
          const evidence = full.map(line=>wordGaps(line,raw));
          const known = evidence.every(line => line.measured.length > 0 && line.unmeasuredInternalSpaces===0 && line.measured.every(gap => gap.excessPt !== null));
          const stretched = known && evidence.every(line => line.measured.every(gap => gap.excessPt! > 0.1));
          const sizes = block.lines.flatMap(line => line.runs.map(run => run.style.fontSizePt));
          const reason = Math.max(...sizes) - Math.min(...sizes) > 1 ? 'mixed-size heading/label, not a uniform prose paragraph'
            : evidence.some(line=>line.charSpacingPt>0.01) ? 'explicit character spacing; not enough evidence for word-only justification'
            : spread > 1 ? 'right-edge spread between 1 and 2 pt'
            : !known ? 'normal space or cross-run word gap unavailable'
            : !stretched ? 'at least one measured word gap not wider than normal by 0.1 pt' : undefined;
          const row = {file,page:entry.pageIndex+1,blockIndex,text:block.text,rect:block.rect,paragraphLineCounts:groups.map(group => group.length),rightEdgeSpreadPt:spread,
            measurementLimit:'Cross-run gaps use measured x/width; internal gaps use glyph/TJ/Tc/Tw traces. Unmatched, custom-matrix and vertical text are explicitly unmeasured.',reason,lines:measurements};
          if (!reason) {candidates.push(row);byFile[file].candidates++;} else {nearMisses.push(row);byFile[file].nearMisses++;}
        }
      }} finally {await document.destroy();}
      process.stdout.write(`POSITION corpus ${Object.keys(snapshot).length}/${files.length}: ${file}\n`);
    }
    const serialized = JSON.stringify(snapshot), hash = createHash('sha256').update(serialized).digest('hex');
    const snapshotPath = 'tmp/5d/source-text-before.json';
    if (existsSync(snapshotPath)) expect(serialized).toBe(await readFile(snapshotPath,'utf8')); else await writeFile(snapshotPath,serialized);
    const summary = {files:files.length,pages:pageCount,lines:lineCount,sha256:hash,historicalChangedPages,leftMultiline,bulletBoxes,candidates:candidates.length,nearMisses:nearMisses.length,byFile,
      thresholds:{edgeSpreadPt:1,nearMissEdgeSpreadPt:2,wordGapExcessPt:0.1,maxCharacterSpacingPt:0.01},status:'Measured diagnostic candidates, not a production classifier. User review and independent visual confirmation remain required.'};
    await writeFile('tmp/5d/justification-survey.json',JSON.stringify({summary,candidates,nearMisses,alignmentExamples},null,2));
    process.stdout.write(`POSITION SUMMARY ${JSON.stringify(summary)}\n`);
    expect(pageCount).toBeGreaterThan(0); expect(lineCount).toBeGreaterThan(9000);
  });
});
