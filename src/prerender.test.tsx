import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prerenderSite, readyPages } from './prerender';
import { HOME_META } from './lib/site/pageMeta';

const template = readFileSync(resolve('index.html'), 'utf8');
const site = prerenderSite(template);
const page = (file: string) => site.find((entry) => entry.file === file)?.html ?? '';
const textOf = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('ready-made pages (readable without JavaScript)', () => {
  it('builds one file for every address of the site', () => {
    expect(site.map(({ file }) => file).sort()).toEqual([
      '404.html', 'app.html', 'index.html', 'privacy.html', 'support.html', 'terms.html', 'tools.html',
      'tools/compress.html', 'tools/copy.html', 'tools/jpg-to-pdf.html', 'tools/lock.html', 'tools/merge.html',
      'tools/organize.html', 'tools/pdf-to-jpg.html', 'tools/repair.html', 'tools/rotate.html', 'tools/sign.html',
      'tools/split.html', 'tools/unlock.html', 'tools/watermark.html',
    ]);
  });

  it('puts each page\'s real content inside #root', () => {
    expect(textOf(page('index.html'))).toContain('Read it. Ask it. Edit it.');
    expect(textOf(page('app.html'))).toContain('HighPal PDF editor');
    expect(textOf(page('tools.html'))).toContain('Merge PDF');
    expect(textOf(page('tools/merge.html'))).toContain('Combine two or more PDFs into one');
    expect(textOf(page('privacy.html'))).toContain('Your PDF stays yours.');
    expect(textOf(page('terms.html'))).toContain('The rules, in plain words.');
    expect(textOf(page('support.html'))).toContain('How can we help?');
    expect(textOf(page('404.html'))).toContain('We couldn’t find that page.');
  });

  it('gives every page its own title, description and real address', () => {
    for (const { file, meta } of readyPages()) {
      const html = page(file);
      expect(html, file).toContain(`<title>${meta.title.replaceAll('&', '&amp;')}</title>`);
      expect(html.match(/<title>/g), file).toHaveLength(1);
      expect(html.match(/<meta name="description"/g), file).toHaveLength(1);
      if (meta.noindex) {
        expect(html, file).not.toContain('rel="canonical"');
        expect(html, file).toContain('<meta name="robots" content="noindex" />');
      } else {
        expect(html, file).toContain(`<link rel="canonical" href="https://highpal.ai${meta.path}" />`);
        expect(html, file).toContain(`<meta property="og:url" content="https://highpal.ai${meta.path}" />`);
        expect(html, file).not.toContain('noindex');
      }
    }
    expect(page('tools/merge.html')).toContain('<title>Merge PDF — Free, No Upload | HighPal</title>');
    expect(page('tools/copy.html')).toContain('noindex');
    expect(page('index.html')).toContain(`<title>${HOME_META.title}</title>`);
  });

  it('adds the hidden label only to the home page: a free, professional PDF editor', () => {
    const label = page('index.html').match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1];
    expect(label).toBeTruthy();
    const app = (JSON.parse(label!) as { '@graph': { '@type': string; description?: string; offers?: { price: string } }[] })['@graph']
      .find((item) => item['@type'] === 'WebApplication')!;
    expect(app.description).toMatch(/^Professional PDF editor: .* 12 PDF tools /);
    expect(app.offers?.price).toBe('0');
    for (const { file } of site.filter(({ file }) => file !== 'index.html')) {
      expect(page(file), file).not.toContain('application/ld+json');
    }
  });

  it('keeps the page shell otherwise unchanged (styles, scripts, icons)', () => {
    for (const { html } of site) {
      expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
      expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
    }
  });
});
