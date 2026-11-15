import { useEffect } from 'react';
import { pageUrl } from './pageMeta';
import type { PageMeta } from './pageMeta';

function setMeta(attribute: 'name' | 'property', key: string, content: string): void {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attribute, key);
    document.head.append(tag);
  }
  tag.content = content;
}

function removeTag(selector: string): void {
  document.head.querySelector(selector)?.remove();
}

/**
 * Put a page's name card into the document head: the tab title, the description, the real
 * address and the shared-link preview text. Moving between pages inside the site (without
 * reloading) keeps them right, matching the ready-made pages built for search engines.
 */
export function applyPageMeta(meta: PageMeta): void {
  document.title = meta.title;
  setMeta('name', 'description', meta.description);
  setMeta('property', 'og:title', meta.title);
  setMeta('property', 'og:description', meta.description);
  if (meta.noindex) {
    removeTag('link[rel="canonical"]');
    removeTag('meta[property="og:url"]');
    setMeta('name', 'robots', 'noindex');
    return;
  }
  removeTag('meta[name="robots"]');
  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.append(canonical);
  }
  canonical.href = pageUrl(meta.path);
  setMeta('property', 'og:url', pageUrl(meta.path));
}

export function usePageMeta(meta: PageMeta | undefined): void {
  const { path, title, description, noindex } = meta ?? {};
  useEffect(() => {
    if (path === undefined || title === undefined || description === undefined) return;
    applyPageMeta({ path, title, description, noindex });
  }, [path, title, description, noindex]);
}
