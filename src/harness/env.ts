let installed = false;

/** Keep PDF.js rendering alive when the verification pane is hidden or not compositing. */
export function installHiddenRenderShim(): void {
  if (installed) return;
  installed = true;

  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (handle: number): void => window.clearTimeout(handle);
}
