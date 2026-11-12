export const SUPPORT_EMAIL = 'pedf.studio@gmail.com';

export function siteHref(path = ''): string {
  const suffix = path.replace(/^\//, '');
  return `${import.meta.env.BASE_URL}${suffix}`;
}
