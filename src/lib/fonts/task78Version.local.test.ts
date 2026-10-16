import { readFile, writeFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as kit from '@pdf-lib/fontkit';
import { extractTextRuns } from '@/lib/pdf/textContent';
import { matchFont } from './fontMatch';
describe.runIf(process.env.TASK78_VERSIONS==='1')('font release matching',()=>{
  it('records source program versions and weights',async()=>{
    const fontkit=(kit as unknown as {default?:typeof kit}).default??kit;
    for(const [file,number] of [['tmp/compress-tests/healing.pdf',2],['tmp/tables/Firgun_QT-H4SNASRX_SriLanka.pdf',1]] as const){
      const doc=await getDocument({data:new Uint8Array(await readFile(file)),verbosity:0,fontExtraProperties:true}).promise;
      try{const page=await doc.getPage(number), runs=await extractTextRuns(page,number-1);
        for(const ref of new Set(runs.map(r=>r.style.fontRef!))){const object=page.commonObjs.get(ref);
          if(!/League|Plex|OpenSans/.test(object.name)||!object.data)continue;
          const source=fontkit.create(object.data),style=runs.find(r=>r.style.fontRef===ref)!.style,match=matchFont(style);
          const local=fontkit.create(new Uint8Array(await readFile('public/fonts/'+match.file)));
          console.log({name:object.name,style,source:{family:source.familyName,subfamily:source.subfamilyName,version:source.version,em:source.unitsPerEm},local:{family:local.familyName,subfamily:local.subfamilyName,version:local.version,em:local.unitsPerEm},widths:['2','Q','R','O','F','a','.'].map(c=>[c,source.glyphForCodePoint(c.codePointAt(0)!).advanceWidth/source.unitsPerEm,local.glyphForCodePoint(c.codePointAt(0)!).advanceWidth/local.unitsPerEm])});
          await writeFile('tmp/task78-assets/source-'+ref+'.ttf',object.data);
        }
      }finally{await doc.destroy();}
    }
  },60000);
});
