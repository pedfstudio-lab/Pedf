// Isolate subset rendering from the editor/handler. Generated PDFs are QA only.
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
const results = [];
for (const variant of ['Regular', 'Bold', 'Italic', 'BoldItalic']) {
  const data = await readFile(`public/fonts/carlito/Carlito-${variant}.ttf`);
  for (const subset of [true, false]) {
    const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
    const page = pdf.addPage([600,120]);
    const font = await pdf.embedFont(data, { subset, features: { liga: false, kern: false } });
    const text = 'Quality ZQ 2026';
    page.drawText(text,{ x:20,y:60,font,size:24,color:rgb(0,0,0) });
    const output = await pdf.save();
    const path = `tmp/task78-match/Carlito-${variant}-${subset?'subset':'full'}.pdf`;
    await writeFile(path,output);
    const source = fontkit.create(data);
    results.push({variant,subset,path,bytes:output.length,glyphs:source.layout(text,{liga:false,kern:false}).glyphs.map(g=>({id:g.id,code:g.codePoints,box:g.bbox}))});
  }
}
await writeFile('tmp/task78-match/carlito-render-probe.json',JSON.stringify(results,null,2));
console.log(results.map(({glyphs,...result})=>result));
