import { describe, expect, it } from 'vitest';
import { buildReadyPage } from './prerenderHtml';

const shell = [
  '<!doctype html><html><head>',
  '<title>Old</title>',
  '<meta name="description" content="Old" />',
  '<link rel="canonical" href="https://highpal.ai/" />',
  '<meta property="og:url" content="https://highpal.ai/" />',
  '<meta property="og:title" content="Old" />',
  '<meta property="og:description" content="Old" />',
  '</head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>',
].join('\n');

describe('buildReadyPage', () => {
  it('writes the page\'s own name card and content, escaping text', () => {
    const html = buildReadyPage(shell, {
      meta: { path: '/tools/merge', title: 'Merge & "join" <PDF>', description: 'A "quoted" & <b>bold</b> line' },
      body: '<main><h1>Merge PDF</h1></main>',
    });
    expect(html).toContain('<title>Merge &amp; "join" &lt;PDF&gt;</title>');
    expect(html).toContain('<meta name="description" content="A &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt; line" />');
    expect(html).toContain('<link rel="canonical" href="https://highpal.ai/tools/merge" />');
    expect(html).toContain('<meta property="og:url" content="https://highpal.ai/tools/merge" />');
    expect(html).toContain('<meta property="og:title" content="Merge &amp; &quot;join&quot; &lt;PDF&gt;" />');
    expect(html).toContain('<div id="root"><main><h1>Merge PDF</h1></main></div>');
    expect(html).toContain('<script type="module" src="/assets/index.js"></script>');
  });

  it('keeps "not found" pages out of search: no real address, and noindex', () => {
    const html = buildReadyPage(shell, { meta: { path: '/404', title: 'Not found', description: 'Gone', noindex: true }, body: '' });
    expect(html).not.toContain('canonical');
    expect(html).not.toContain('og:url');
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it('adds the hidden label as data that can never close its script tag', () => {
    const html = buildReadyPage(shell, {
      meta: { path: '/', title: 'Home', description: 'Home page' },
      body: '',
      structuredData: { name: 'HighPal</script><script>alert(1)</script>' },
    });
    const label = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1] ?? '';
    expect(label).not.toContain('</script');
    expect(JSON.parse(label)).toEqual({ name: 'HighPal</script><script>alert(1)</script>' });
  });

  it('stops the build if index.html no longer has a tag it expects', () => {
    expect(() => buildReadyPage(shell.replace(/<meta property="og:url"[^>]*>/, ''), {
      meta: { path: '/', title: 'Home', description: 'Home page' }, body: '',
    })).toThrow(/og:url/);
  });
});
