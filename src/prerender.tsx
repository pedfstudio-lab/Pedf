/**
 * Build time only (never sent to visitors): draws every website page in advance, so search
 * engines, AI assistants and link previews can read each page without running JavaScript. The
 * build add-on in vite.config.ts calls prerenderSite() and writes the files into dist/.
 */
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { EditorIntro } from './components/EditorIntro';
import { Landing } from './components/Landing';
import { NotFoundPage } from './components/NotFoundPage';
import { StaticSitePage } from './components/StaticSitePage';
// Importing the tools page also registers every tool.
import ToolsApp from './components/tools/ToolsApp';
import {
  EDITOR_META, HOME_META, NOT_FOUND_META, PRIVACY_META, SUPPORT_META, TERMS_META, TOOLS_META, toolPageMeta,
} from './lib/site/pageMeta';
import { buildReadyPage } from './lib/site/prerenderHtml';
import type { ReadyPage } from './lib/site/prerenderHtml';
import { homeStructuredData } from './lib/site/structuredData';
import { getTool, listTools } from './lib/tools/registry';

export interface ReadyFile extends ReadyPage {
  /** Where the page goes inside dist/. Cloudflare serves tools/merge.html at /tools/merge. */
  readonly file: string;
}

const draw = (page: ReactNode) => renderToString(<StrictMode>{page}</StrictMode>);

/** Every address of the site, with its name card and content. */
export function readyPages(): ReadyFile[] {
  const publicTools = listTools();
  // Hidden (internal) tools stay reachable by address, so they get a page too (kept out of search).
  const hiddenTools = ['copy'].map((slug) => getTool(slug)).filter((tool) => tool !== undefined);
  return [
    { file: 'index.html', meta: HOME_META, body: draw(<Landing />), structuredData: homeStructuredData(publicTools.length) },
    { file: 'app.html', meta: EDITOR_META, body: draw(<EditorIntro />) },
    { file: 'tools.html', meta: TOOLS_META, body: draw(<ToolsApp />) },
    ...[...publicTools, ...hiddenTools].map((tool) => ({
      file: `tools/${tool.slug}.html`, meta: toolPageMeta(tool), body: draw(<ToolsApp slug={tool.slug} />),
    })),
    { file: 'privacy.html', meta: PRIVACY_META, body: draw(<StaticSitePage kind="privacy" />) },
    { file: 'terms.html', meta: TERMS_META, body: draw(<StaticSitePage kind="terms" />) },
    { file: 'support.html', meta: SUPPORT_META, body: draw(<StaticSitePage kind="support" />) },
    // Cloudflare sends this, with a "not found" status, for any other address.
    { file: '404.html', meta: NOT_FOUND_META, body: draw(<NotFoundPage />) },
  ];
}

/** The finished files, from the built dist/index.html. */
export function prerenderSite(template: string): { readonly file: string; readonly html: string }[] {
  return readyPages().map((page) => ({ file: page.file, html: buildReadyPage(template, page) }));
}
