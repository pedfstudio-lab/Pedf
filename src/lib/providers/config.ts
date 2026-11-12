export interface ProviderConfig {
  readonly mode: 'direct' | 'proxy';
  readonly sarvamBaseUrl: string;
  readonly getSarvamKey: () => string;
}

/**
 * Every Sarvam request goes through the site's own route (/api/sarvam), which adds the
 * owner's key on the server: the Cloudflare secret SARVAM_API_KEY on the live site, the
 * private .dev.vars file during local development (vite.config.ts). The browser never holds
 * a key. "direct" mode remains only for tests.
 */
export const providerConfig: ProviderConfig = {
  mode: 'proxy',
  sarvamBaseUrl: '/api/sarvam',
  getSarvamKey: () => '',
};
