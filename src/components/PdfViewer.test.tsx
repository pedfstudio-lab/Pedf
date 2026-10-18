// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PdfViewer } from './PdfViewer';
const mocks = vi.hoisted(() => ({ eligibility: new Map<number, boolean>(), prefetch: new Map<number, boolean>(),
  plan: Array.from({ length: 8 }, (_, index) => ({ id: String(index), kind: 'source', sourceIndex: index })) }));
vi.mock('@/state/editsStore', () => ({ useEdits: () => ({ pagePlan: mocks.plan }) }));
vi.mock('@/state/documentStore', () => ({ useDocumentStore: () => ({ clearPageCanvases: () => undefined }) }));
vi.mock('@/lib/smart/locationDetect', () => ({ getDocumentLocations: async () => [] }));
vi.mock('./PageToolbar', () => ({ PageToolbar: () => null }));
vi.mock('./PageCanvas', () => ({ PageCanvas: ({ pageIndex, translationEligible, translationPrefetch }: {
  pageIndex: number; translationEligible: boolean; translationPrefetch: boolean;
}) => {
  mocks.eligibility.set(pageIndex, translationEligible); mocks.prefetch.set(pageIndex, translationPrefetch); return null;
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mocks.eligibility.clear(); mocks.prefetch.clear(); });
describe('translation lazy pages', () => {
  it('enables only the pages actually visible and the next one, never the whole PDF', async () => {
    let notify!: IntersectionObserverCallback;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; }
      observe() {} disconnect() {}
    });
    const doc = { numPages: 8, getPage: async () => ({}) } as unknown as PDFDocumentProxy;
    const geometry = Array.from({ length: 8 }, (_, index) => ({ pageIndex: index, widthPt: 600, heightPt: 800, rotation: 0 as const, boxOffset: { x: 0, y: 0 } }));
    const view = render(<main><PdfViewer doc={doc} originalPages={geometry} zoom={1} editMode={false} textAddMode={false} imageMode={false} peek={false} /></main>);
    await waitFor(() => expect(mocks.eligibility.size).toBe(8));
    expect([...mocks.eligibility.values()].some(Boolean)).toBe(false);
    const element = view.container.querySelector('[data-page-index="2"]')!;
    act(() => notify([{ target: element, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect([...mocks.eligibility].filter(([, eligible]) => eligible).map(([index]) => index)).toEqual([2, 3]);
    // Only the page below the view is a warm-up; the page being read goes first.
    expect([...mocks.prefetch].filter(([, prefetch]) => prefetch).map(([index]) => index)).toEqual([3]);
    const next = view.container.querySelector('[data-page-index="3"]')!;
    act(() => notify([{ target: element, isIntersecting: false }, { target: next, isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect([...mocks.eligibility].filter(([, eligible]) => eligible).map(([index]) => index)).toEqual([3, 4]);
  });
});
