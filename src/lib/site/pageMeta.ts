import type { SiteRoute } from './routes';

/**
 * Each page's "name card": the title shown in the browser tab, Google's blue link and shared-link
 * previews, the description Google may show under the link, and the page's one real address.
 * Visitors don't see these on the page itself. Descriptions stay under 160 characters, so Google
 * shows them whole.
 */
export interface PageMeta {
  /** The page's own address, for example '/tools/merge'. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** Kept out of search results (page not found, internal pages). */
  readonly noindex?: boolean;
}

export const SITE_URL = 'https://highpal.ai';

export const HOME_META: PageMeta = {
  path: '/',
  title: 'HighPal — Professional PDF Editor | Read it. Ask it. Edit it.',
  description: 'Professional PDF editor in your browser. Edit text, sign, merge and compress, or talk to your PDF in Indian languages. Your file stays on your device.',
};

export const EDITOR_META: PageMeta = {
  path: '/app',
  title: 'PDF Editor — HighPal',
  description: 'Edit text and images, sign and add pages in your PDF, right in your browser. Talk to or chat with your PDF in Indian languages. Your file stays on your device.',
};

export const TOOLS_META: PageMeta = {
  path: '/tools',
  title: 'Free PDF Tools — HighPal',
  description: 'Merge, split, compress, sign, lock and unlock PDFs, and more. Free, in your browser, and your files are never uploaded.',
};

export const PRIVACY_META: PageMeta = {
  path: '/privacy',
  title: 'Privacy — HighPal',
  description: 'Your PDF stays on your device. Only the text needed to answer or translate is sent to Sarvam AI, and only when you use chat, voice or Translate.',
};

export const TERMS_META: PageMeta = {
  path: '/terms',
  title: 'Terms of Use — HighPal',
  description: 'The rules for using HighPal, the free professional PDF editor, in plain words: your documents, AI features, responsible use and your rights.',
};

export const SUPPORT_META: PageMeta = {
  path: '/support',
  title: 'Support — HighPal',
  description: "Need help with HighPal? Email us with what happened, your browser and your PDF's language.",
};

export const NOT_FOUND_META: PageMeta = {
  path: '/404',
  title: 'Page not found — HighPal',
  description: "This page doesn't exist. Open the HighPal PDF editor, the free PDF tools, or the home page instead.",
  noindex: true,
};

/** A tool page: the tool's own sentence, plus the promise that matters most. */
export function toolPageMeta(tool: { readonly slug: string; readonly title: string; readonly description: string; readonly hidden?: boolean }): PageMeta {
  return {
    path: `/tools/${tool.slug}`,
    title: `${tool.title} — Free, No Upload | HighPal`,
    description: `${tool.description} Free, and your file never leaves your device.`,
    // Internal tools stay reachable by address but out of search results.
    noindex: tool.hidden,
  };
}

/** The name card for every page except tool pages (the tools part of the site sets those). */
export function routePageMeta(route: SiteRoute): PageMeta | undefined {
  switch (route) {
    case 'landing': return HOME_META;
    case 'app': return EDITOR_META;
    case 'privacy': return PRIVACY_META;
    case 'terms': return TERMS_META;
    case 'support': return SUPPORT_META;
    case 'notFound': return NOT_FOUND_META;
    default: return undefined;
  }
}

/** The full address Google and link previews use. */
export function pageUrl(path: string): string {
  return `${SITE_URL}${path}`;
}
