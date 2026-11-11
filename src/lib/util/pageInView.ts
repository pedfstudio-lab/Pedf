/**
 * The page the user is looking at: the page under the middle of the scrolling area, or the
 * one closest to it. Measures the on-screen page boxes ([data-page-index]), never the
 * off-screen canvases pages are drawn into.
 */
export function pageInView(scroll: HTMLElement): number {
  const center = scroll.getBoundingClientRect().top + scroll.clientHeight / 2;
  let closestPage = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const box of scroll.querySelectorAll<HTMLElement>('[data-page-index]')) {
    const index = Number(box.dataset.pageIndex);
    if (!Number.isInteger(index)) continue;
    const rect = box.getBoundingClientRect();
    if (rect.top <= center && rect.bottom >= center) return index;
    const distance = Math.min(Math.abs(center - rect.top), Math.abs(center - rect.bottom));
    if (distance < closestDistance) {
      closestPage = index;
      closestDistance = distance;
    }
  }
  return closestPage;
}

/** Scrolls the page to the middle of the scrolling area, so something just added to it is in view. */
export function scrollPageIntoView(scroll: HTMLElement, pageIndex: number): void {
  const box = scroll.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`);
  if (!box) return;
  const scrollRect = scroll.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  scroll.scrollTop += boxRect.top + boxRect.height / 2 - (scrollRect.top + scroll.clientHeight / 2);
}
