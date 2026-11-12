import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORT_EMAIL } from '@/lib/site/config';

// HighPal at https://highpal.ai: the name, icons, share preview and search files all agree.
const SITE = 'https://highpal.ai';
const html = readFileSync(resolve('index.html'), 'utf8');
const pngSize = (file: string) => {
  const bytes = readFileSync(resolve('public', file));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe('HighPal brand', () => {
  it('names the site HighPal in the page head, with its official address', () => {
    expect(html).toContain('<title>HighPal — Read it. Ask it. Edit it.</title>');
    expect(html).toContain(`<link rel="canonical" href="${SITE}/" />`);
    expect(html).toContain(`<meta property="og:url" content="${SITE}/" />`);
  });

  it('shows a share preview picture on WhatsApp, LinkedIn and others', () => {
    expect(html).toContain(`<meta property="og:image" content="${SITE}/og-image.png" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(pngSize('og-image.png')).toEqual({ width: 1200, height: 630 });
  });

  it('has a browser-tab icon and phone home-screen icons', () => {
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(readFileSync(resolve('public/favicon.svg'), 'utf8')).toContain('<svg');
    expect(statSync(resolve('public/favicon.ico')).size).toBeGreaterThan(0);
    expect(pngSize('apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
    const manifest = JSON.parse(readFileSync(resolve('public/site.webmanifest'), 'utf8')) as { name: string; icons: { src: string }[] };
    expect(manifest.name).toBe('HighPal');
    for (const { src } of manifest.icons) expect(statSync(resolve('public', src.slice(1))).size).toBeGreaterThan(0);
  });

  it('tells search engines where the pages are, without the hidden tool', () => {
    expect(readFileSync(resolve('public/robots.txt'), 'utf8')).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    const sitemap = readFileSync(resolve('public/sitemap.xml'), 'utf8');
    for (const page of ['/', '/app', '/tools', '/tools/merge', '/tools/sign', '/privacy', '/terms', '/support']) {
      expect(sitemap).toContain(`<loc>${SITE}${page}</loc>`);
    }
    expect(sitemap).not.toContain('/tools/copy');
  });

  it('gives a real support address, not the placeholder', () => {
    expect(SUPPORT_EMAIL).toBe('pedf.studio@gmail.com');
  });

  it('no longer shows the old name anywhere visitors can see it', () => {
    const leftovers = [resolve('index.html'), ...sources(resolve('src'))]
      .filter((file) => /PEDF Studio|<strong>PEDF<\/strong>/.test(readFileSync(file, 'utf8')));
    expect(leftovers).toEqual([]);
  });
});
