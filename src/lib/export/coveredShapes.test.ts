import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns } from '@/lib/pdf/textContent';
import { buildPageStreamTree } from './formStreams';
import { countShapeFormUses, planCoveredShapeRemoval, rewriteShapePaintOperators } from './coveredShapes';
import { exportPdf } from './exportPdf';
import { exportPagePreview } from './exportPagePreview';
import type { CoverEdit, TextEdit } from './types';

const rect = { x:20,y:20,w:4,h:4 };
const cover: CoverEdit = {id:'dot',kind:'cover',pageIndex:0,z:1,rect:{x:19,y:19,w:6,h:6},sampleBackground:true,replacesShapes:[{rect}]};
async function fixture(source: string, formUses = 0, acrossPages = false) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([200,200]);
  if (formUses) {
    const form = pdf.context.register(pdf.context.flateStream(source,{Type:'XObject',Subtype:'Form',BBox:[0,0,200,200],Resources:{}}));
    page.node.setXObject(PDFName.of('Dot'),form);
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream(acrossPages ? '/Dot Do' : Array.from({length:formUses},()=>'/Dot Do').join('\n'))));
    if (acrossPages) { const second = pdf.addPage([200,200]); second.node.setXObject(PDFName.of('Alias'),form); second.node.addContentStream(pdf.context.register(pdf.context.flateStream('/Alias Do'))); }
  } else page.node.addContentStream(pdf.context.register(pdf.context.flateStream(source)));
  return pdf;
}
describe('recorded drawn-dot removal', () => {
  it.each(['all','text','picture','shape'])('omits a mixed cover only when text, pictures and shapes are all gone (%s)',async missing=>{
    const pdf=await PDFDocument.create(),page=pdf.addPage([200,200]),font=await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('Old words',{x:40,y:100,size:12,font});page.drawCircle({x:22,y:104,size:2,color:rgb(0,0,0)});
    const image=await pdf.embedPng(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0)));
    page.drawImage(image,{x:20,y:80,width:4,height:4});
    const originalBytes=await pdf.save(),reader=await getDocument({data:originalBytes.slice(),verbosity:0}).promise;
    const runs=await extractTextRuns(await reader.getPage(1),0);await reader.destroy();
    const mixed:CoverEdit={...cover,rect:{x:18,y:78,w:140,h:40},replaces:runs.map(run=>({text:missing==='text'?'Missing words':run.text,rect:run.rect})),
      replacesImages:[{kind:'image',rect:{x:missing==='picture'?999:20,y:80,w:4,h:4}}],
      replacesShapes:[{rect:{x:missing==='shape'?999:20,y:102,w:4,h:4}}]};
    let patches=0;
    const result=await exportPdf({originalBytes,pages:[{pageIndex:0,widthPt:200,heightPt:200,rotation:0,boxOffset:{x:0,y:0}}],edits:[mixed],sampleBackground:()=>{patches++;return{r:1,g:1,b:1};}});
    expect(patches>0).toBe(missing!=='all');
    if(missing==='all'){expect(result.redaction.removedImages).toBe(1);expect(result.redaction.removedShapes).toBe(1);}
  });
  it('removes a whole contained path, preserving path/state and text-show tokens', async () => {
    const pdf = await fixture('q 20 20 4 4 re f Q');
    const plan = planCoveredShapeRemoval(pdf,0,[cover],new Map());
    expect(plan).toMatchObject({removedShapes:1,unmatchedShapes:0,satisfied:[true]});
    const tree = buildPageStreamTree(pdf,0)!;
    expect(new TextDecoder().decode(rewriteShapePaintOperators(tree.roots[0]!.tokens,plan.rewrites)!)).toContain('re n');
  });
  it.each(['20 20 4 4 re 100 100 20 20 re f','20 20 30 4 re f','20 20 4 4 re W f'])('keeps shared, crossing or clipping paths: %s',async source=>{
    const plan = planCoveredShapeRemoval(await fixture(source),0,[cover],new Map());
    expect(plan).toMatchObject({removedShapes:0,unmatchedShapes:1,satisfied:[false]});
  });
  it('removes a dot inside a once-drawn Form',async()=>{
    const pdf = await fixture('20 20 4 4 re f',1), uses = countShapeFormUses(pdf);
    expect(planCoveredShapeRemoval(pdf,0,[cover],uses[0]!)).toMatchObject({removedShapes:1,satisfied:[true]});
    const result=await exportPdf({originalBytes:await pdf.save(),pages:[{pageIndex:0,widthPt:200,heightPt:200,rotation:0,boxOffset:{x:0,y:0}}],edits:[cover]});
    expect(result.redaction.removedShapes,JSON.stringify({redaction:result.redaction,warnings:result.warnings})).toBe(1);
    const after=await PDFDocument.load(result.bytes),surviving=buildPageStreamTree(after,0)!.roots[0]!.form('Dot')!;
    expect(surviving.tokens.some(token=>token.kind==='word'&&token.value==='f')).toBe(false);
    expect(surviving.tokens.some(token=>token.kind==='word'&&token.value==='n')).toBe(true);
  });
  it('does not copy or rewrite a reused Form to remove its words instead of its dot',async()=>{
    const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
    const form=pdf.context.register(pdf.context.flateStream('20 20 4 4 re f BT /F1 12 Tf 1 0 0 1 30 20 Tm (Old words) Tj ET',
      {Type:'XObject',Subtype:'Form',BBox:[0,0,200,200],Resources:{Font:{F1:font.ref}}}));
    for(let i=0;i<2;i++){const page=pdf.addPage([200,200]);page.node.setXObject(PDFName.of('Shared'),form);page.node.addContentStream(pdf.context.register(pdf.context.flateStream('/Shared Do')));}
    const originalBytes=await pdf.save(),reader=await getDocument({data:originalBytes.slice(),verbosity:0}).promise;
    const runs=await extractTextRuns(await reader.getPage(1),0);await reader.destroy();
    const edits:CoverEdit[]=[{...cover,rect:{x:19,y:19,w:110,h:16},replaces:runs.map(run=>({text:run.text,rect:run.rect}))}];
    const result=await exportPdf({originalBytes,pages:[0,1].map(pageIndex=>({pageIndex,widthPt:200,heightPt:200,rotation:0 as const,boxOffset:{x:0,y:0}})),edits});
    expect(result.redaction.removedShapes).toBe(0);expect(result.redaction.removedItems).toBe(0);
    const after=await PDFDocument.load(result.bytes);
    const first=after.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'));
    const second=after.getPage(1).node.Resources()!.lookup(PDFName.of('XObject'));
    expect(first!.toString()).toBe(second!.toString());
    expect(buildPageStreamTree(after,0)!.roots[0]!.form('Shared')!.tokens.some(token=>token.kind==='word'&&token.value==='f')).toBe(true);
  });
  it.each([false,true])('keeps a reused Form, including use on another page (%s), and preview retains the patch',async across=>{
    const pdf = await fixture('20 20 4 4 re f',2,across), uses = countShapeFormUses(pdf);
    expect(planCoveredShapeRemoval(pdf,0,[cover],uses[0]!)).toMatchObject({removedShapes:0,satisfied:[false]});
    const originalBytes = await pdf.save(), pages = pdf.getPages().map((_,pageIndex)=>({pageIndex,widthPt:200,heightPt:200,rotation:0 as const,boxOffset:{x:0,y:0}}));
    const result = await exportPdf({originalBytes,pages,edits:[cover],sampleBackground:()=>({r:1,g:1,b:1})});
    expect(result.redaction.removedShapes).toBe(0);
    const preview = await exportPagePreview({document:{originalBytes,pages,edits:[cover]},pageIndex:0,selection:{key:'dot',transientEdits:[],coverIds:['dot'],omitTextIds:[],paintSupported:true}});
    expect(preview.clean).toBe(false);
    const after = await PDFDocument.load(result.bytes);
    const form = after.getPage(across ? 1 : 0).node.Resources()!.lookup(PDFName.of('XObject'));
    expect(form).toBeDefined();
    const surviving = buildPageStreamTree(after,across ? 1 : 0)!.roots[0]!.form(across ? 'Alias' : 'Dot');
    expect(surviving!.tokens.some(token=>token.kind==='word'&&token.value==='f')).toBe(true);
  });
  it('preserves unclaimed page artwork and removes only the recorded dot',async()=>{
    const pdf = await fixture('20 20 4 4 re f 100 100 20 20 re f');
    pdf.getPage(0).drawRectangle({x:0,y:0,width:200,height:10,color:rgb(1,0,0)});
    expect(planCoveredShapeRemoval(pdf,0,[cover],new Map()).removedShapes).toBe(1);
  });
});

const pageGeometry = (pageIndex: number) => ({ pageIndex, widthPt: 200, heightPt: 200, rotation: 0 as const, boxOffset: { x: 0, y: 0 } });
async function wordsAndDot(dot = true, brokenSecondPage = false) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([200, 200]), font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Old item', { x: 40, y: 100, size: 12, font });
  if (dot) page.drawCircle({ x: 22, y: 104, size: 2, color: rgb(0, 0, 0) });
  if (brokenSecondPage) {
    // A page whose content cannot be decoded makes the whole-document Form audit fail.
    const broken = PDFRawStream.of(pdf.context.obj({ Filter: 'FlateDecode' }), new Uint8Array([1, 2, 3, 4, 5]));
    pdf.addPage([200, 200]).node.addContentStream(pdf.context.register(broken));
  }
  const originalBytes = await pdf.save(), reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
  const runs = await extractTextRuns(await reader.getPage(1), 0); await reader.destroy();
  return { originalBytes, pages: brokenSecondPage ? [pageGeometry(0), pageGeometry(1)] : [pageGeometry(0)],
    replaces: runs.map((run) => ({ text: run.text, rect: run.rect })) };
}
const redrawnDot: TextEdit = { id: 'marker', kind: 'text', pageIndex: 0, z: 2, rect: { x: 20, y: 100, w: 120, h: 12 }, text: '•',
  style: { fontName: 'Helvetica', fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } } };

describe('Task 76 review fixes', () => {
  it.each(['20 20 4 4 re f 20 20 4 4 re S', '20 20 4 4 re f 20 20 4 4 re B'])(
    'keeps the patch when something else still paints inside the dot: %s', async (source) => {
      const plan = planCoveredShapeRemoval(await fixture(source), 0, [cover], new Map());
      expect(plan).toMatchObject({ satisfied: [false], unmatchedShapes: 1 });
    });

  it('tolerates an extra Q like a viewer does', async () => {
    expect(planCoveredShapeRemoval(await fixture('Q 20 20 4 4 re f'), 0, [cover], new Map())).toMatchObject({ satisfied: [true] });
  });

  it('still removes the old words when the dot cannot be planned, and keeps the patch', async () => {
    const { originalBytes, pages, replaces } = await wordsAndDot(true, true);
    const list: CoverEdit = { ...cover, rect: { x: 16, y: 96, w: 120, h: 20 }, replaces, replacesShapes: [{ rect: { x: 20, y: 102, w: 4, h: 4 } }] };
    let patches = 0;
    const result = await exportPdf({ originalBytes, pages, edits: [list, redrawnDot], sampleBackground: () => { patches += 1; return { r: 1, g: 1, b: 1 }; } });
    expect(result.redaction.removedItems).toBeGreaterThan(0);
    expect(result.redaction.removedShapes).toBe(0);
    expect(patches).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.startsWith('Old drawn bullets on page 1'))).toBe(true);
  });

  it.each([true, false])('a list saved before Task 76 keeps its patch only over drawn dots (dot drawn: %s)', async (dot) => {
    const { originalBytes, pages, replaces } = await wordsAndDot(dot);
    const old: CoverEdit = { id: 'old', kind: 'cover', pageIndex: 0, z: 1, rect: { x: 16, y: 96, w: 120, h: 20 }, sampleBackground: true, replaces };
    let patches = 0;
    const result = await exportPdf({ originalBytes, pages, edits: [old, redrawnDot], sampleBackground: () => { patches += 1; return { r: 1, g: 1, b: 1 }; } });
    expect(result.redaction.removedItems).toBeGreaterThan(0);
    expect(patches > 0).toBe(dot);
  });
});
