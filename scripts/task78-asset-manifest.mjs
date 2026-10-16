import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest=JSON.parse(await readFile('public/fonts/SOURCES.json','utf8')).filter(entry=>!/^liberation\/|^r1width\//.test(entry.file));
const source='https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz';
for(const directory of ['liberation','r1width'])for(const name of await readdir(`public/fonts/${directory}`)){
  if(!name.endsWith('.ttf'))continue;
  const file=`${directory}/${name}`,bytes=await readFile('public/fonts/'+file);
  manifest.push({family:name.split('-')[0],file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),source,
    ...(directory==='r1width'?{derivative:'scripts/task78-width-fonts.py; renamed, X-only wdth axis; hinting removed'}:{}),licence:`${directory}/OFL.txt`});
}
const summary={};
for(const entry of manifest){
  if((await stat('public/fonts/'+entry.file)).size!==entry.bytes)throw new Error('Asset changed: '+entry.file);
  const copyright=await readFile('public/fonts/'+entry.licence,'utf8');
  if(!/Version 1.1/.test(copyright)||!/Copyright|copyright/.test(copyright))throw new Error('Missing font licence: '+entry.file);
  const directory=entry.file.split('/')[0],row=summary[directory]??={fonts:0,bytes:0,licence:entry.licence};row.fonts++;row.bytes+=entry.bytes;
}
await writeFile('public/fonts/SOURCES.json',JSON.stringify(manifest,null,2)+'\n');
await writeFile('tmp/task78-assets/size-summary.json',JSON.stringify(summary,null,2)+'\n');
process.stdout.write(JSON.stringify(summary,null,2)+'\n');
