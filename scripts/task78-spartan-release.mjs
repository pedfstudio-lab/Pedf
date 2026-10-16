import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
if(process.argv.includes('--install')) {
  const commit='f1c5917c52e6425ffeeee8e3d070775b9f396cf6';
  const licence=await readFile('tmp/task78-assets/spartan-legacy-LICENSE.txt','utf8');
  if(!licence.includes('Micah Rich')||!licence.includes('Version 1.1'))throw new Error('Original OFL not audited');
  const path='leaguespartan-legacy/LeagueSpartan-Bold.ttf';
  const url=`https://raw.githubusercontent.com/theleagueof/league-spartan/${commit}/_webfonts/leaguespartan-bold.ttf`;
  const response=await fetch(url);if(!response.ok)throw new Error(String(response.status));
  const bytes=Buffer.from(await response.arrayBuffer());
  await mkdir('public/fonts/leaguespartan-legacy',{recursive:true});
  await writeFile('public/fonts/'+path,bytes);await writeFile('public/fonts/leaguespartan-legacy/OFL.txt',licence);
  const manifest=JSON.parse(await readFile('public/fonts/SOURCES.json','utf8')).filter(entry=>entry.file!==path);
  manifest.push({family:'LeagueSpartan',file:path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),source:url,licence:'leaguespartan-legacy/OFL.txt'});
  await writeFile('public/fonts/SOURCES.json',JSON.stringify(manifest,null,2)+'\n');
  process.stdout.write(`Installed audited original League Spartan: ${bytes.length} bytes\n`);
  process.exit(0);
}
const get = async path => {
  const response = await fetch(`https://api.github.com/repos/theleagueof/league-spartan/${path}`);
  if (!response.ok) throw new Error(`${response.status}: ${path}`); return response.json();
};
const tags = await get('tags');
process.stdout.write(JSON.stringify(tags.map(tag=>({name:tag.name,sha:tag.commit.sha})))+'\n');
for(const tag of tags){
  if(!/1\.0|original/i.test(tag.name))continue;
  const tree=await get(`git/trees/${tag.commit.sha}?recursive=1`);
  process.stdout.write(JSON.stringify(tree.tree.map(entry=>entry.path).filter(path=>/ofl|license|ttf$/i.test(path)))+'\n');
  for(const entry of tree.tree.filter(entry=>entry.path==='ofl.markdown')){
    const url=`https://raw.githubusercontent.com/theleagueof/league-spartan/${tag.commit.sha}/${entry.path}`;
    const response=await fetch(url), text=await response.text();
    await writeFile('tmp/task78-assets/spartan-legacy-LICENSE.txt',text);
    process.stdout.write(url+'\n'+text+'\n');
  }
}
