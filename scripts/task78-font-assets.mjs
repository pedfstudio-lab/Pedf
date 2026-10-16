// Reproducible upstream audit. --audit downloads licences/tree metadata only.
// Font installation is a separate, explicit step after licence review.
import { mkdir, writeFile } from 'node:fs/promises';
const sources = [
  ['carlito', 'google/fonts', 'main', 'ofl/carlito/OFL.txt', 'ofl/carlito/'],
  ['lato', 'google/fonts', 'main', 'ofl/lato/OFL.txt', 'ofl/lato/'],
  ['allura', 'google/fonts', 'main', 'ofl/allura/OFL.txt', 'ofl/allura/'],
  ['opensans', 'googlefonts/opensans', 'main', 'OFL.txt', 'fonts/'],
  ['ibmplexsans', 'IBM/plex', 'master', 'LICENSE.txt', ''],
  ['leaguespartan', 'theleagueof/league-spartan', 'master', 'OFL.txt', ''],
  ['notosans', 'notofonts/noto-fonts', 'main', 'LICENSE', 'hinted/ttf/NotoSans/'],
  ['sourcesanspro', 'adobe-fonts/source-sans', '2.045R-ro/1.095R-it', 'LICENSE.txt', 'TTF/'],
  ['bricolagegrotesque', 'ateliertriay/bricolage', 'main', 'OFL.txt', 'fonts/'],
  ['liberation', 'liberationfonts/liberation-fonts', '2.1.5', 'LICENSE', ''],
];
const headers = { 'User-Agent': 'R1-Task78-licence-audit', Accept: 'application/vnd.github+json' };
async function get(url) { const response = await fetch(url, { headers }); if (!response.ok) throw new Error(`${response.status} ${url}`); return response; }
const commits = new Map();
const audit = [];
await mkdir('tmp/task78-assets', { recursive: true });
for (const [id, repo, ref, license, root] of sources) {
  try {
    const key = `${repo}/${ref}`;
    if (!commits.has(key)) commits.set(key, (await (await get(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`)).json()).sha);
    const commit = commits.get(key), base = `https://raw.githubusercontent.com/${repo}/${commit}/`;
    const text = await (await get(base + license)).text();
    await writeFile(`tmp/task78-assets/${id}-LICENSE.txt`, text);
    let paths;
    if (repo === 'google/fonts') paths = (await (await get(`https://api.github.com/repos/${repo}/contents/${root}?ref=${commit}`)).json()).map(entry => entry.path);
    else paths = (await (await get(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`)).json()).tree.map(entry => entry.path).filter(path => path.startsWith(root));
    const fonts = paths.filter(path => /\.ttf$/i.test(path) && !/variable|\[|unhinted|webfont/i.test(path));
    audit.push({ id, repo, commit, license, licenseUrl: base + license, fonts });
    process.stdout.write(JSON.stringify({ id, commit, licenseHeader: text.split('\n').slice(0, 5), fonts: fonts.filter(path => /regular|bold|italic/i.test(path)).slice(0, 20) }) + '\n');
  } catch (error) { audit.push({ id, error: String(error) }); process.stdout.write(`${id}: ${error}\n`); }
}
await writeFile('tmp/task78-assets/audit.json', JSON.stringify(audit, null, 2));
