import { useEffect, useMemo, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PageGeometry } from '@/lib/pdf/types';
import { planToGeometry } from '@/state/pagePlan';
import { getDocumentLocations } from '@/lib/smart/locationDetect';
import type { DetectedLocation } from '@/lib/smart/locationDetect';
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
}

export function PdfViewer({ doc, originalPages, zoom, editMode, textAddMode, imageMode, peek }: PdfViewerProps) {
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [locations, setLocations] = useState<DetectedLocation[]>([]);
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
    let cancelled = false;
    setLocations([]);
    void getDocumentLocations(doc)
      .then((detected) => {
        if (!cancelled) setLocations(detected);
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn('location detection unavailable', error);
      });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const locationsBySourcePage = useMemo(() => {
    const grouped = new Map<number, DetectedLocation[]>();
    for (const location of locations) {
      const pageLocations = grouped.get(location.pageIndex) ?? [];
      pageLocations.push(location);
      grouped.set(location.pageIndex, pageLocations);
    }
    return grouped;
  }, [locations]);

  useEffect(() => {
    clearPageCanvases();
  }, [clearPageCanvases, pagePlan]);

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      {pagePlan.map((entry, position) => {
        const geometry = livePages[position];
        if (!geometry) return null;
        const page = entry.kind === 'source' ? pages[entry.sourceIndex] : undefined;
        if (entry.kind === 'source' && !page) return null;
        const source = entry.kind === 'blank'
          ? { kind: 'blank' as const, widthPt: entry.widthPt, heightPt: entry.heightPt }
          : { kind: 'pdf' as const, page: page as PDFPageProxy };
        return (
          <div key={entry.id} className="flex flex-col items-center gap-1">
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
              locations={entry.kind === 'source'
                ? (locationsBySourcePage.get(entry.sourceIndex) ?? []).map((location) => ({
                    ...location,
                    pageIndex: position,
                  }))
                : []}
            />
          </div>
        );
      })}
    </div>
  );
}
