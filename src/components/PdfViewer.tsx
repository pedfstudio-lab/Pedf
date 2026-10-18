import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PageGeometry } from '@/lib/pdf/types';
import { planToGeometry } from '@/state/pagePlan';
import { useDocumentStore } from '@/state/documentStore';
import { useEdits } from '@/state/editsStore';
import { PageCanvas } from './PageCanvas';
import { PageToolbar } from './PageToolbar';

interface PdfViewerProps {
  doc: PDFDocumentProxy;
  originalPages: readonly PageGeometry[];
  zoom: number;
  editMode: boolean;
  textAddMode: boolean;
  imageMode: boolean;
  peek: boolean;
  onLayout?(): void;
}

export function PdfViewer({
  doc,
  originalPages,
  zoom,
  editMode,
  textAddMode,
  imageMode,
  peek,
  onLayout,
}: PdfViewerProps) {
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const viewer = useRef<HTMLDivElement>(null);
  const [visibility, setVisibility] = useState<{ doc: PDFDocumentProxy; pages: readonly number[] }>();
  const visiblePages = visibility?.doc === doc ? visibility.pages : [];
  const { pagePlan } = useEdits();
  const { clearPageCanvases } = useDocumentStore();
  const livePages = useMemo(
    () => planToGeometry(pagePlan, originalPages),
    [originalPages, pagePlan],
  );

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    (async () => {
      const loaded: PDFPageProxy[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        if (cancelled) return;
        loaded.push(page);
      }
      if (!cancelled) setPages(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  useEffect(() => {
    clearPageCanvases();
  }, [clearPageCanvases, pagePlan]);

  useEffect(() => {
    if (!onLayout || pages.length === 0) return;
    const frame = window.requestAnimationFrame(onLayout);
    return () => window.cancelAnimationFrame(frame);
  }, [onLayout, pagePlan, pages, zoom]);

  useEffect(() => {
    const element = viewer.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') { setVisibility({ doc, pages: [0] }); return; }
    const visible = new Set<number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.pageIndex);
        if (entry.isIntersecting) visible.add(index); else visible.delete(index);
      }
      setVisibility({ doc, pages: [...visible].sort((a, b) => a - b) });
    }, { root: element.closest('main'), threshold: 0 });
    element.querySelectorAll('[data-page-index]').forEach(page => observer.observe(page));
    return () => observer.disconnect();
  }, [doc, pages, pagePlan, zoom]);
  const translationPages = new Set(visiblePages);
  const lastVisible = visiblePages.at(-1);
  // The next page is translated ahead of scrolling, after the pages in view.
  const prefetchPage = lastVisible === undefined ? undefined : lastVisible + 1;
  if (prefetchPage !== undefined) translationPages.add(prefetchPage);

  return (
    <div ref={viewer} className="flex flex-col items-center gap-4 py-4">
      {pagePlan.map((entry, position) => {
        const geometry = livePages[position];
        if (!geometry) return null;
        const page = entry.kind === 'source' ? pages[entry.sourceIndex] : undefined;
        if (entry.kind === 'source' && !page) return null;
        const source = entry.kind === 'blank'
          ? { kind: 'blank' as const, widthPt: entry.widthPt, heightPt: entry.heightPt }
          : { kind: 'pdf' as const, page: page as PDFPageProxy };
        return (
          <div
            key={entry.id}
            className="flex flex-col items-center gap-1"
            data-page-index={position}
          >
            <PageToolbar
              position={position}
              widthPt={geometry.widthPt}
              heightPt={geometry.heightPt}
            />
            <PageCanvas
              source={source}
              pageIndex={position}
              zoom={zoom}
              editMode={editMode}
              textAddMode={textAddMode}
              imageMode={imageMode}
              peek={peek}
              translationEligible={translationPages.has(position)}
              translationPrefetch={position === prefetchPage}
            />
          </div>
        );
      })}
    </div>
  );
}
