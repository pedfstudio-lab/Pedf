/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { LoadedDocument } from '@/lib/pdf/loadDocument';

interface OpenDocument {
  readonly loaded: LoadedDocument;
  readonly fileName: string;
}

export interface PageCanvasRegistration {
  readonly canvas: HTMLCanvasElement;
  readonly viewport: PageViewport;
  readonly dpr: number;
}

interface DocumentStoreValue {
  readonly document: OpenDocument | null;
  setDocument(document: OpenDocument | null): void;
  registerPageCanvas(pageIndex: number, registration: PageCanvasRegistration | null): void;
  getPageCanvas(pageIndex: number): PageCanvasRegistration | undefined;
}

const DocumentStoreContext = createContext<DocumentStoreValue | null>(null);

export function DocumentStoreProvider({ children }: { readonly children: ReactNode }) {
  const [document, setDocument] = useState<OpenDocument | null>(null);
  const pageCanvases = useRef(new Map<number, PageCanvasRegistration>());
  const registerPageCanvas = useCallback(
    (pageIndex: number, registration: PageCanvasRegistration | null) => {
      if (registration) pageCanvases.current.set(pageIndex, registration);
      else pageCanvases.current.delete(pageIndex);
    },
    [],
  );
  const getPageCanvas = useCallback(
    (pageIndex: number) => pageCanvases.current.get(pageIndex),
    [],
  );
  const value = useMemo(
    () => ({ document, setDocument, registerPageCanvas, getPageCanvas }),
    [document, getPageCanvas, registerPageCanvas],
  );

  return (
    <DocumentStoreContext.Provider value={value}>
      {children}
    </DocumentStoreContext.Provider>
  );
}

export function useDocumentStore(): DocumentStoreValue {
  const store = useContext(DocumentStoreContext);
  if (!store) throw new Error('useDocumentStore must be used inside DocumentStoreProvider');
  return store;
}
