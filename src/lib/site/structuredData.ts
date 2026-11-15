import { SUPPORTED_LANGUAGES } from '@/state/prefsStore';
import { pageUrl } from './pageMeta';

/**
 * The hidden label on the home page that tells Google, Bing and AI assistants what HighPal is
 * (schema.org facts). Visitors never see it. No star ratings: those need real reviews.
 */
export function homeStructuredData(publicToolCount: number) {
  const home = pageUrl('/');
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${home}#website`,
        url: home,
        name: 'HighPal',
        publisher: { '@id': `${home}#organization` },
      },
      {
        '@type': 'Organization',
        '@id': `${home}#organization`,
        name: 'HighPal',
        url: home,
        logo: pageUrl('/icon-512.png'),
      },
      {
        '@type': 'WebApplication',
        '@id': `${home}#app`,
        name: 'HighPal',
        url: home,
        description: `Professional PDF editor: edit text and images, sign, and use ${publicToolCount} PDF tools (merge, compress, lock and more), plus talk to or chat with your PDF.`,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Windows, macOS, Android, iOS',
        browserRequirements: 'Works in any modern browser. Requires JavaScript.',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
        inLanguage: SUPPORTED_LANGUAGES.map(({ code }) => code),
        publisher: { '@id': `${home}#organization` },
      },
    ],
  };
}
