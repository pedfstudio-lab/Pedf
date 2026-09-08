export const SUPPORT_EMAIL = 'support@example.com';

export function siteHref(path = ''): string {
  const suffix = path.replace(/^\//, '');
  return `${import.meta.env.BASE_URL}${suffix}`;
}
