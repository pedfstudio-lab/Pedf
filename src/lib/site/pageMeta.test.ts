import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readyPages } from '@/prerender';
import {
  EDITOR_META, HOME_META, NOT_FOUND_META, PRIVACY_META, SUPPORT_META, TERMS_META, TOOLS_META, routePageMeta, toolPageMeta,
} from './pageMeta';

const pages = readyPages();

describe('page name cards (title, description, real address)', () => {
  it('keeps every description short enough for Google to show it whole', () => {
    for (const { file, meta } of pages) {
      expect(meta.description.length, file).toBeLessThanOrEqual(160);
      expect(meta.description.length, file).toBeGreaterThan(50);
      expect(meta.title.length, file).toBeLessThanOrEqual(70);
    }
  });

  it('gives every page its own title, description and address', () => {
    const shown = pages.filter(({ meta }) => !meta.noindex);
    for (const key of ['title', 'description', 'path'] as const) {
      const values = shown.map(({ meta }) => meta[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
  });

  it('leads with "Professional PDF editor" on the home page', () => {
    expect(HOME_META.title).toBe('HighPal — Professional PDF Editor | Read it. Ask it. Edit it.');
    expect(HOME_META.description).toMatch(/^Professional PDF editor in your browser\./);
  });

  it('names tool pages "<tool> — Free, No Upload | HighPal"', () => {
    expect(toolPageMeta({ slug: 'merge', title: 'Merge PDF', description: 'Combine PDFs.' })).toEqual({
      path: '/tools/merge',
      title: 'Merge PDF — Free, No Upload | HighPal',
      description: 'Combine PDFs. Free, and your file never leaves your device.',
      noindex: undefined,
    });
    expect(toolPageMeta({ slug: 'copy', title: 'Copy PDF', description: 'x', hidden: true }).noindex).toBe(true);
  });

  it('maps each kind of page to its card', () => {
    expect(routePageMeta('landing')).toBe(HOME_META);
    expect(routePageMeta('app')).toBe(EDITOR_META);
    expect(routePageMeta('privacy')).toBe(PRIVACY_META);
    expect(routePageMeta('terms')).toBe(TERMS_META);
    expect(routePageMeta('support')).toBe(SUPPORT_META);
    expect(routePageMeta('notFound')).toBe(NOT_FOUND_META);
    expect(routePageMeta({ kind: 'tools' })).toBeUndefined();
    expect(TOOLS_META.path).toBe('/tools');
  });

  it('lists exactly the pages meant for search in sitemap.xml', () => {
    const sitemap = [...readFileSync(resolve('public/sitemap.xml'), 'utf8').matchAll(/<loc>https:\/\/highpal\.ai([^<]*)<\/loc>/g)]
      .map(([, path]) => path || '/');
    const searchable = pages.filter(({ meta }) => !meta.noindex).map(({ meta }) => meta.path);
    expect([...sitemap].sort()).toEqual([...searchable].sort());
  });

  it('keeps index.html (the page shell) in step with the home page card', () => {
    const shell = readFileSync(resolve('index.html'), 'utf8');
    expect(shell).toContain(`<title>${HOME_META.title}</title>`);
    expect(shell).toContain(`<meta name="description" content="${HOME_META.description}" />`);
    expect(shell).toContain(`<meta property="og:description" content="${HOME_META.description}" />`);
    expect(shell).toContain('<link rel="canonical" href="https://highpal.ai/" />');
  });

  it('tells Cloudflare to answer "not found" (404.html) for addresses that aren\'t pages', () => {
    const settings = readFileSync(resolve('wrangler.jsonc'), 'utf8');
    expect(settings).toMatch(/"not_found_handling":\s*"404-page"/);
    expect(pages.some(({ file }) => file === '404.html')).toBe(true);
  });
});
