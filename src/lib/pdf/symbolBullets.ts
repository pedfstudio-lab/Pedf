/** Only the additional private-use code confirmed by Task 76's corpus. */
export const WINGDINGS_ARROW = '\uF0D8';
export const ARROW_BULLET = '➢';
export function isArrowBullet(character: string): boolean {
  return character === WINGDINGS_ARROW || character === ARROW_BULLET;
}
export function visibleBulletSymbol(character: string): string {
  return isArrowBullet(character) ? ARROW_BULLET : '•';
}
export function normalizeSymbolBulletPrefix(text: string): string {
  return text.replace(/^(\s*)\uF0D8/u, `$1${ARROW_BULLET}`);
}
