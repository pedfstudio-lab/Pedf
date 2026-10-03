import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolve } from 'node:path';
import { exportPagePreview, PagePreviewSource } from './exportPagePreview';
import type { PagePreviewSelection } from './exportPagePreview';
import { exportPdf } from './exportPdf';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { buildTextBlockEdits } from '@/lib/edit/buildTextEdits';
import type { CoverEdit, EditDocument, TextEdit } from './types';
import { detectBulletListFromRegions } from '@/lib/pdf/bulletList';
import { textPreviewSelection } from '@/lib/pdf/textPreviewSelection';
import { imageRegionsFromOperatorList } from '@/lib/pdf/images';
import { imageDrawsInContent } from '@/lib/images/extractImage';
const BLACK_PIXEL_PNG_BASE64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const canvasModule = await import('@napi-rs/canvas').catch(()=>undefined);
const standardFontDataUrl = resolve('node_modules/pdfjs-dist/standard_fonts') + '/';

async function fixture() {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i=0;i<3;i++) {
    const page = pdf.addPage([360,440]);
    page.drawRectangle({x:10,y:260,width:330,height:100,color:rgb(.2,.4,.7)});
    page.drawRectangle({x:10,y:260,width:330,height:100,borderColor:rgb(0,0,0),borderWidth:2});
    page.drawText(`OLD TARGET ${i}`,{x:30,y:310,size:18,font,color:rgb(1,1,1)});
    page.drawText(`UNTOUCHED ${i}`,{x:30,y:220,size:12,font});
    if (i===1) {page.setRotation(degrees(90));page.setCropBox(5,10,345,415);}
  }
  const originalBytes=await pdf.save();
  const reader=await getDocument({data:originalBytes.slice(),fontExtraProperties:true,verbosity:0}).promise;
  const pages:EditDocument['pages']=[];
  for (let i=0;i<3;i++) {
    const page=await reader.getPage(i+1); const [x=0,y=0,right=0,top=0]=page.view;
    pages.push({pageIndex:i,widthPt:right-x,heightPt:top-y,rotation:page.rotate as 0|90,boxOffset:{x,y}});
  }
  const block=groupRunsIntoBlocks(await extractTextRuns(await reader.getPage(2),1)).find((block)=>block.text.includes('OLD TARGET'))!;
  const built=buildTextBlockEdits(block,{text:'NEW TARGET',style:block.style,width:block.rect.w,height:block.rect.h,dx:0,dy:0},['NEW TARGET'],1);
  const doc:EditDocument={originalBytes,pages,edits:[...built.covers,...built.texts]};
  const selection:PagePreviewSelection={key:'target',coverIds:built.covers.map((edit)=>edit.id),omitTextIds:built.texts.map((edit)=>edit.id),transientEdits:[],paintSupported:true};
  return {doc,reader,built,selection,source:new PagePreviewSource(originalBytes,reader)};
}
async function text(bytes:Uint8Array,pageNumber=1) {
  const reader=await getDocument({data:bytes.slice(),verbosity:0}).promise;
  try {return {count:reader.numPages,page:await reader.getPage(pageNumber),text:(await(await reader.getPage(pageNumber)).getTextContent()).items.flatMap((item)=>'str' in item?[item.str]:[]).join(' ')};}
  finally {await reader.destroy();}
}
async function pixels(bytes:Uint8Array,pageNumber=1) {
  const reader=await getDocument({data:bytes.slice(),standardFontDataUrl,verbosity:0}).promise;
  try {
    const page=await reader.getPage(pageNumber),viewport=page.getViewport({scale:2});
    const canvas=canvasModule!.createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    const context=canvas.getContext('2d');
    await page.render({canvasContext:context as unknown as CanvasRenderingContext2D,viewport}).promise;
    return context.getImageData(0,0,canvas.width,canvas.height).data;
  } finally {await reader.destroy();}
}

describe('one-page preview',()=>{
  it('removes text-glyph list markers and items without claiming an image',async()=>{
    const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
    const page=pdf.addPage([360,440]);
    const markerFont=await pdf.embedFont(StandardFonts.HelveticaBold);
    page.drawText('•',{x:30,y:330,size:12,font:markerFont});
    page.drawText('First list item',{x:44,y:330,size:12,font});
    page.drawText('•',{x:30,y:316,size:12,font:markerFont});
    page.drawText('Second list item',{x:44,y:316,size:12,font});
    page.drawText('Neighbour section',{x:30,y:250,size:12,font});
    const originalBytes=await pdf.save(),reader=await getDocument({data:originalBytes.slice(),fontExtraProperties:true,verbosity:0}).promise;
    const source=new PagePreviewSource(originalBytes,reader);
    try {
      const blocks=groupRunsIntoBlocks(await extractTextRuns(await reader.getPage(1),0));
      const list=blocks.map((block)=>detectBulletListFromRegions(block,[],[])).find((list)=>list!==null);
      expect(list).toBeDefined();
      const selection=textPreviewSelection(list!.block,undefined,list!);
      const result=await exportPagePreview({document:{originalBytes,pages:[{pageIndex:0,widthPt:360,heightPt:440,rotation:0,boxOffset:{x:0,y:0}}],edits:[]},pageIndex:0,selection},source);
      expect(result.clean).toBe(true);
      const extracted=await text(result.bytes);
      expect(extracted.text).not.toContain('list item');expect(extracted.text).not.toContain('•');
      expect(extracted.text).toContain('Neighbour section');
    } finally {source.dispose();await reader.destroy();}
  });
  it('removes the selected replacement while retaining source removal and unrelated edits without mutating inputs',async()=>{
    const f=await fixture();
    try {
      const extra:TextEdit={...f.built.texts[0]!,id:'extra',text:'OTHER EDIT',origin:'free',z:30,rect:{x:30,y:170,w:200,h:12}};
      f.doc.edits.push(extra);
      const snapshot=JSON.stringify(f.doc),sourceBytes=f.doc.originalBytes.slice();
      const result=await exportPagePreview({document:f.doc,pageIndex:1,selection:f.selection},f.source);
      const extracted=await text(result.bytes);
      expect(result.clean).toBe(true);expect(extracted.count).toBe(1);
      expect(extracted.text).not.toContain('OLD TARGET');expect(extracted.text).not.toContain('NEW TARGET');
      expect(extracted.text).toContain('UNTOUCHED 1');expect(extracted.text).toContain('OTHER EDIT');
      expect(result.renderedEditIds.has(extra.id)).toBe(true);expect(result.renderedEditIds.has(f.built.texts[0]!.id)).toBe(false);
      expect(JSON.stringify(f.doc)).toBe(snapshot);expect(f.doc.originalBytes).toEqual(sourceBytes);
    } finally {f.source.dispose();await f.reader.destroy();}
  });
  it('resolves reordered/duplicated live pages and their geometry, and produces a blank live page',async()=>{
    const f=await fixture();
    try {
      f.doc.plan=[{id:'duplicate',kind:'source',sourceIndex:1},{id:'blank',kind:'blank',widthPt:250,heightPt:300},{id:'original',kind:'source',sourceIndex:1}];
      f.doc.pages=[{...f.doc.pages[1]!,pageIndex:0},{pageIndex:1,widthPt:250,heightPt:300,rotation:0,boxOffset:{x:0,y:0}},{...f.doc.pages[1]!,pageIndex:2}];
      f.doc.edits=f.doc.edits.map((edit)=>({...edit,pageIndex:2}));
      const duplicate=await text((await exportPagePreview({document:f.doc,pageIndex:0},f.source)).bytes);
      const edited=await text((await exportPagePreview({document:f.doc,pageIndex:2},f.source)).bytes);
      const blank=await text((await exportPagePreview({document:f.doc,pageIndex:1},f.source)).bytes);
      expect(duplicate.text).toContain('OLD TARGET 1');expect(duplicate.page.rotate).toBe(90);
      expect(edited.text).toContain('NEW TARGET');expect(edited.text).not.toContain('OLD TARGET');
      expect(blank.text).toBe('');expect(blank.page.view).toEqual([0,0,250,300]);
    } finally {f.source.dispose();await f.reader.destroy();}
  });
  it('removes picture list markers and items, leaving no patch',async()=>{
    const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
    const page=pdf.addPage([360,440]);
    const dot=await pdf.embedPng(Buffer.from(BLACK_PIXEL_PNG_BASE64,'base64'));
    page.drawImage(dot,{x:28,y:332,width:5,height:5});
    page.drawText('First list item',{x:40,y:330,size:12,font});
    page.drawImage(dot,{x:28,y:318,width:5,height:5});
    page.drawText('Second list item',{x:40,y:316,size:12,font});
    page.drawText('Neighbour section',{x:30,y:250,size:12,font});
    const originalBytes=await pdf.save(),reader=await getDocument({data:originalBytes.slice(),fontExtraProperties:true,verbosity:0}).promise;
    const source=new PagePreviewSource(originalBytes,reader);
    try {
      const sourcePage=await reader.getPage(1);
      const regions=imageRegionsFromOperatorList(await sourcePage.getOperatorList(),sourcePage.getViewport({scale:1}),0);
      const blocks=groupRunsIntoBlocks(await extractTextRuns(sourcePage,0),{ruleLines:[],markers:regions});
      const list=blocks.map((block)=>detectBulletListFromRegions(block,regions)).find((list)=>list!==null);
      expect(list?.items.length).toBe(2);expect(list?.items.every((item)=>item.markerImage)).toBe(true);
      const selection=textPreviewSelection(list!.block,undefined,list!);
      const result=await exportPagePreview({document:{originalBytes,pages:[{pageIndex:0,widthPt:360,heightPt:440,rotation:0,boxOffset:{x:0,y:0}}],edits:[]},pageIndex:0,selection},source);
      expect(result.reason).toBeUndefined();expect(result.clean).toBe(true);
      const extracted=await text(result.bytes);
      expect(extracted.text).not.toContain('list item');expect(extracted.text).toContain('Neighbour section');
      expect(imageDrawsInContent(await PDFDocument.load(result.bytes),0)).toEqual([]);
    } finally {source.dispose();await reader.destroy();}
  });
  it('rejects unsatisfied removal, unsupported paint and a marker picture that cannot be found with a reason',async()=>{
    const f=await fixture();
    try {
      const unmatched:CoverEdit={...f.built.covers[0]!,id:'unmatched',replaces:[{text:'NOT IN THE FILE',rect:f.built.covers[0]!.rect}]};
      const missingPicture:CoverEdit={...f.built.covers[0]!,id:'image',replacesImages:[{kind:'image',rect:{x:20,y:20,w:5,h:5}}]};
      for (const selection of [
        {...f.selection,paintSupported:false},
        {...f.selection,coverIds:['unmatched'],transientEdits:[unmatched]},
        {...f.selection,coverIds:['image'],transientEdits:[missingPicture]},
      ]) {
        const result=await exportPagePreview({document:f.doc,pageIndex:1,selection},f.source);
        expect(result.clean).toBe(false);expect(result.reason).toBeTruthy();
      }
    } finally {f.source.dispose();await f.reader.destroy();}
  });
  it.skipIf(!canvasModule)('renders exactly the full export, with replacement ink actually visible',async()=>{
    const f=await fixture();
    try {
      const preview=await exportPagePreview({document:f.doc,pageIndex:1},f.source);
      const full=await exportPdf(f.doc);
      const previewPixels=await pixels(preview.bytes);
      expect(Buffer.compare(Buffer.from(previewPixels),Buffer.from(await pixels(full.bytes,2)))).toBe(0);
      const empty=await exportPagePreview({document:f.doc,pageIndex:1,selection:f.selection},f.source);
      expect(Buffer.compare(Buffer.from(previewPixels),Buffer.from(await pixels(empty.bytes)))).not.toBe(0);
    } finally {f.source.dispose();await f.reader.destroy();}
  });
});
