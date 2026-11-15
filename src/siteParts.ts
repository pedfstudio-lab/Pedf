import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { resolveRoute } from './lib/site/routes';

type OnDemand<P> = ComponentType<P> | LazyExoticComponent<ComponentType<P>>;

/**
 * A part of the site that loads its code on demand. If its code was loaded before the site first
 * appears (see preloadRoute), it is used directly, so the ready-made page built for search
 * engines is swapped for the live one in one step, without a "loading" flash in between. The
 * choice is made once, so the component never changes identity (which would reset it).
 */
function loadOnDemand<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | undefined;
  let chosen: OnDemand<P> | undefined;
  const Lazy = lazy(async () => {
    const module = await load();
    loaded = module.default;
    return module;
  });
  return {
    preload: async () => {
      loaded ??= (await load()).default;
    },
    component: (): OnDemand<P> => (chosen ??= loaded ?? Lazy),
  };
}

export const editorPart = loadOnDemand(() => import('./App'));
export const toolsPart = loadOnDemand(() => import('./components/tools/ToolsApp'));

/** Load the code of the page at this address before the site first appears. */
export async function preloadRoute(pathname: string, hash: string): Promise<void> {
  const route = resolveRoute(pathname, hash);
  if (typeof route === 'object') await toolsPart.preload();
  else if (route === 'app') await editorPart.preload();
}
