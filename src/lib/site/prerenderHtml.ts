import { pageUrl } from './pageMeta';
import type { PageMeta } from './pageMeta';

export interface ReadyPage {
  readonly meta: PageMeta;
  /** The page's content, drawn in advance (what a visitor sees before the code loads). */
  readonly body: string;
  /** The hidden schema.org label (home page only). */
  readonly structuredData?: unknown;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Replace exactly one match, so a changed index.html fails the build instead of shipping wrong tags. */
function replaceOnce(html: string, pattern: RegExp, replacement: string, what: string): string {
  const matches = html.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
  if (matches?.length !== 1) throw new Error(`Ready-made page: expected one ${what} in index.html, found ${matches?.length ?? 0}.`);
  return html.replace(pattern, () => replacement);
}

/**
 * One ready-made page from the built index.html: its own title, description, real address and
 * link-preview text in the head, and its content inside #root (the live page replaces it).
 */
export function buildReadyPage(template: string, page: ReadyPage): string {
  const { meta } = page;
  const title = escapeAttribute(meta.title);
  const description = escapeAttribute(meta.description);
  const url = escapeAttribute(pageUrl(meta.path));
  let html = template;
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${escapeText(meta.title)}</title>`, 'title');
  html = replaceOnce(html, /<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${description}" />`, 'description');
  html = replaceOnce(html, /<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${title}" />`, 'og:title');
  html = replaceOnce(html, /<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${description}" />`, 'og:description');
  if (meta.noindex) {
    // Not a page to show in search: no real address, and ask search engines to leave it out.
    html = replaceOnce(html, /\s*<link rel="canonical" href="[^"]*"\s*\/?>/, '', 'canonical');
    html = replaceOnce(html, /\s*<meta property="og:url" content="[^"]*"\s*\/?>/, '', 'og:url');
    html = replaceOnce(html, /<\/head>/, '  <meta name="robots" content="noindex" />\n  </head>', 'head end');
  } else {
    html = replaceOnce(html, /<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${url}" />`, 'canonical');
    html = replaceOnce(html, /<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${url}" />`, 'og:url');
  }
  if (page.structuredData) {
    // JSON inside <script>: escape "<" so the text can never close the tag. It is data, not
    // code, so the site's safety rules (which block inline scripts) don't block it.
    const json = JSON.stringify(page.structuredData).replaceAll('<', '\\u003c');
    html = replaceOnce(html, /<\/head>/, `  <script type="application/ld+json">${json}</script>\n  </head>`, 'head end');
  }
  return replaceOnce(html, /<div id="root"><\/div>/, `<div id="root">${page.body}</div>`, 'root element');
}
