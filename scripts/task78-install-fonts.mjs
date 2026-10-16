// Run only after reviewing the pinned licences produced by task78-font-assets.mjs.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const audit = JSON.parse(await readFile('tmp/task78-assets/audit.json', 'utf8'));
const selection = {
  carlito: ['ofl/carlito/', 'Carlito'], lato: ['ofl/lato/', 'Lato'],
  allura: ['ofl/allura/', 'Allura'], opensans: ['fonts/ttf/', 'OpenSans'],
  ibmplexsans: ['packages/plex-sans/fonts/complete/ttf/', 'IBMPlexSans'],
  leaguespartan: ['fonts/ttf/', 'LeagueSpartan'],
  notosans: ['hinted/ttf/NotoSans/', 'NotoSans'], sourcesanspro: ['TTF/', 'SourceSansPro'],
  bricolagegrotesque: ['fonts/ttf/', 'BricolageGrotesque'],
};
const manifest = [];
for (const [id, [folder, family]] of Object.entries(selection)) {
  const entry = audit.find(value => value.id === id);
  if (!entry?.commit) throw new Error(`No audited source: ${id}`);
  const license = await readFile(`tmp/task78-assets/${id}-LICENSE.txt`, 'utf8');
  if (!/SIL OPEN FONT LICENSE Version 1.1/.test(license)) throw new Error(`Unapproved licence: ${id}`);
  await mkdir(`public/fonts/${id}`, { recursive: true });
  await writeFile(`public/fonts/${id}/OFL.txt`, license);
  const paths = entry.fonts.filter(path => path.startsWith(folder) && new RegExp(`/${family}-(Regular|Bold|Italic|It|BoldItalic|BoldIt|Semibold|SemiboldIt|SemiBold|SemiBoldItalic|Medium|MediumItalic|Light|LightItalic|Black|BlackItalic|ExtraBold)\\.ttf$`).test(path));
  for (const path of paths) {
    const url = `https://raw.githubusercontent.com/${entry.repo}/${entry.commit}/${path}`;
    const response = await fetch(url); if (!response.ok) throw new Error(`${response.status} ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer()), file = path.split('/').at(-1);
    await writeFile(`public/fonts/${id}/${file}`, bytes);
    manifest.push({ family, file: `${id}/${file}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), source: url, licence: `${id}/OFL.txt` });
  }
  process.stdout.write(`${id}: ${paths.length} fonts\n`);
}
await writeFile('public/fonts/SOURCES.json', JSON.stringify(manifest, null, 2) + '\n');
