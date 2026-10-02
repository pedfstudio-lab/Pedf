import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { createBlankViewport } from '@/lib/pdf/blankViewport';
import { samePageRenderIdentity, shouldRasterizeInitially } from '@/lib/pdf/pageRenderState';
import type { PageRenderIdentity } from '@/lib/pdf/pageRenderState';
import { renderPage } from '@/lib/pdf/renderPage';
import { pdfjs } from '@/lib/pdf/worker';
import { acquirePagePreviewService } from '@/lib/pdf/pagePreviewService';
import type { PagePreviewService } from '@/lib/pdf/pagePreviewService';
import { PagePreviewController } from '@/lib/pdf/pagePreviewController';
import type { PagePreviewBridge, PagePreviewState } from '@/lib/pdf/pagePreviewController';
import type { PagePreviewResult, PagePreviewSelection } from '@/lib/export/exportPagePreview';
import type { Edit, PdfRect } from '@/lib/export/types';
import { sampleCanvasTextBackground } from '@/lib/export/inkExtent';
import { useDocumentStore } from '@/state/documentStore';
import { useEdits } from '@/state/editsStore';
import { planToGeometry } from '@/state/pagePlan';
import type { DetectedLocation } from '@/lib/smart/locationDetect';
import { OverlayLayer } from './OverlayLayer';

interface PageCanvasProps {
  source: { readonly kind: 'pdf'; readonly page: PDFPageProxy }
    | { readonly kind: 'blank'; readonly widthPt: number; readonly heightPt: number };
  pageIndex: number; zoom: number; editMode: boolean; textAddMode: boolean; imageMode: boolean; peek: boolean;
  locations: readonly DetectedLocation[]; locationNames: readonly string[];
}
interface RenderInfo { readonly identity: PageRenderIdentity; readonly viewport: PageViewport; readonly dpr: number; readonly zoom: number }
interface RenderedPreview { readonly canvas: HTMLCanvasElement; readonly result: PagePreviewResult }
const EMPTY_IDS: ReadonlySet<string> = new Set();
const identities = new WeakMap<Edit, number>();
let nextIdentity = 0;
function editKey(edits: readonly Edit[]): string {
  return edits.map((edit) => {
    let id = identities.get(edit);
    if (id === undefined) { id = ++nextIdentity; identities.set(edit, id); }
    return id;
  }).join(',');
}

/** Owns ephemeral renders. Sampling continues to read the pristine offscreen raster. */
export function PageCanvas({ source, pageIndex, zoom, editMode, textAddMode, imageMode, peek, locations, locationNames }: PageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const originalRef = useRef<HTMLCanvasElement>();
  const serviceRef = useRef<PagePreviewService>();
  const controller = useRef(new PagePreviewController<RenderedPreview>(2));
  const closeCommitRef = useRef<(() => void)>();
  const invalidateEditorRef = useRef<(() => void)>();
  const selectionContentRef = useRef('');
  const settledKeyRef = useRef<string>();
  const idlePreviewRef = useRef<{key:string;rendered:RenderedPreview}>();
  const [renderInfo, setRenderInfo] = useState<RenderInfo | null>(null);
  const [selection, setSelection] = useState<PagePreviewSelection>();
  const [suspended, setSuspended] = useState(false);
  const [state, setState] = useState<PagePreviewState>('original');
  const [renderedIds, setRenderedIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [reason, setReason] = useState<string>();
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const { document, registerPageCanvas } = useDocumentStore();
  const { edits, pagePlan } = useEdits();
  const page = source.kind === 'pdf' ? source.page : undefined;
  const blankWidth = source.kind === 'blank' ? source.widthPt : undefined;
  const blankHeight = source.kind === 'blank' ? source.heightPt : undefined;
  const initial = shouldRasterizeInitially(pageIndex, typeof IntersectionObserver !== 'undefined');
  const [shouldRasterize, setShouldRasterize] = useState(initial);
  const [near, setNear] = useState(initial);
  const identity: PageRenderIdentity = { page, pageIndex, blankWidth, blankHeight };
  const activeInfo = renderInfo && samePageRenderIdentity(renderInfo.identity, identity) ? renderInfo : null;
  const cssViewport = page?.getViewport({ scale: zoom });
  const cssWidth = cssViewport?.width ?? (blankWidth ?? 0) * zoom;
  const cssHeight = cssViewport?.height ?? (blankHeight ?? 0) * zoom;
  const pageEdits = useMemo(() => edits.filter((edit) => edit.pageIndex === pageIndex), [edits, pageIndex]);
  const entry = pagePlan[pageIndex];
  const contentKey = `${entry?.id}:${entry?.kind === 'source' ? entry.sourceIndex : 'blank'}:${pageIndex}:${editKey(pageEdits)}`;
  const idleKey = `${contentKey}:${zoom}:${dpr}`;
  const contentRef = useRef(contentKey); contentRef.current = contentKey;
  const idleKeyRef = useRef(idleKey); idleKeyRef.current = idleKey;
  const blocked = peek || imageMode || textAddMode || suspended;

  const swap = useCallback((canvas: HTMLCanvasElement) => {
    const visible = canvasRef.current;
    if (!visible) return;
    // Never resize/clear the visible canvas until every replacement pixel is ready.
    visible.width = canvas.width; visible.height = canvas.height;
    visible.style.width = canvas.style.width; visible.style.height = canvas.style.height;
    visible.getContext('2d', {willReadFrequently:true})?.drawImage(canvas,0,0);
  }, []);

  useEffect(() => {
    const resized = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener('resize',resized);
    return () => window.removeEventListener('resize',resized);
  }, []);
  useEffect(() => {
    if (!containerRef.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((item) => item.isIntersecting);
      setNear(visible); if (visible) setShouldRasterize(true);
    }, {root:containerRef.current.closest('main'),rootMargin:'1200px 0px'});
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document) return;
    const acquired = acquirePagePreviewService(document.loaded);
    serviceRef.current = acquired.service;
    const currentController = controller.current;
    return () => { serviceRef.current = undefined; acquired.release(); currentController.clear(); idlePreviewRef.current=undefined;settledKeyRef.current=undefined; };
  }, [document]);
  useEffect(() => {
    if (editMode && near) void serviceRef.current?.prepare(entry?.kind === 'source' ? entry.sourceIndex : undefined).catch(()=>undefined);
  }, [editMode,near,entry]);
  useEffect(() => { if (!near && !selection) {controller.current.clear();idlePreviewRef.current=undefined;} }, [near,selection]);

  useEffect(() => {
    if (page && !shouldRasterize) return;
    let cancelled = false;
    const offscreen = window.document.createElement('canvas');
    const viewport = page?.getViewport({scale:zoom*dpr}) ?? createBlankViewport(blankWidth ?? 1,blankHeight ?? 1,zoom*dpr);
    let task: ReturnType<typeof renderPage>['task'] | undefined;
    const draw = async () => {
      if (page) { task = renderPage(page,offscreen,zoom).task; await task.promise; }
      else {
        offscreen.width = Math.ceil(viewport.width); offscreen.height = Math.ceil(viewport.height);
        offscreen.style.width = `${viewport.width/dpr}px`; offscreen.style.height = `${viewport.height/dpr}px`;
        const context = offscreen.getContext('2d',{willReadFrequently:true});
        if (!context) throw new Error('2D canvas context unavailable');
        context.fillStyle = '#fff'; context.fillRect(0,0,offscreen.width,offscreen.height);
      }
      if (cancelled) return;
      originalRef.current = offscreen;
      if (!renderInfo) swap(offscreen);
      registerPageCanvas(pageIndex,{canvas:offscreen,viewport,dpr});
      setRenderInfo({identity:{page,pageIndex,blankWidth,blankHeight},viewport,dpr,zoom});
    };
    void draw().catch((error:unknown)=>{if (!cancelled) console.error('page render failed',error);});
    return () => {cancelled=true;task?.cancel();registerPageCanvas(pageIndex,null);};
    // renderInfo must not restart the pristine render that just completed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page,pageIndex,blankWidth,blankHeight,shouldRasterize,zoom,dpr,registerPageCanvas,swap]);

  const sampleBackground = useCallback((rect:PdfRect) => {
    const canvas = originalRef.current; const viewport = activeInfo?.viewport;
    const context = canvas?.getContext('2d',{willReadFrequently:true});
    if (!canvas || !context || !viewport) return {r:1,g:1,b:1};
    return sampleCanvasTextBackground({width:canvas.width,height:canvas.height,
      read:(x,y,w,h)=>context.getImageData(x,y,w,h).data},viewport,rect);
  }, [activeInfo]);
  const produce = useCallback(async (active?:PagePreviewSelection):Promise<RenderedPreview> => {
    if (!serviceRef.current || !document) throw new Error('No preview source is available.');
    const result = await serviceRef.current.export({document:{originalBytes:document.loaded.originalBytes,
      pages:planToGeometry(pagePlan,document.loaded.pages),plan:pagePlan,edits:[...edits],
      sampleBackground:(_index,rect)=>sampleBackground(rect)},pageIndex,selection:active});
    if (!result.clean) throw new Error(result.reason ?? 'The text cannot be removed safely.');
    const loading = pdfjs.getDocument({data:result.bytes.slice(),fontExtraProperties:true});
    try {
      const reader = await loading.promise; const previewPage = await reader.getPage(1);
      const canvas = window.document.createElement('canvas');
      await renderPage(previewPage,canvas,zoom).task.promise;
      return {canvas,result};
    } finally {await loading.destroy();}
  }, [document,edits,pagePlan,pageIndex,sampleBackground,zoom]);
  const produceRef = useRef(produce); produceRef.current = produce;
  const begin = useCallback((active:PagePreviewSelection,invalidateEditor?:()=>void)=>{
    controller.current.invalidate(); closeCommitRef.current=undefined;
    invalidateEditorRef.current=invalidateEditor;selectionContentRef.current=contentRef.current;
    setReason(undefined);setState('preparing-edit');setSelection(active);
  }, []);
  const warm = useCallback((active:PagePreviewSelection)=>{
    if (serviceRef.current) void controller.current.warm(`${idleKeyRef.current}:edit:${active.key}`,()=>produceRef.current(active)).catch(()=>undefined);
  }, []);
  const cancel = useCallback(()=>{
    controller.current.invalidate();closeCommitRef.current=undefined;invalidateEditorRef.current=undefined;
    const idle = idlePreviewRef.current;
    if (idle?.key === `${idleKeyRef.current}:idle`) {
      swap(idle.rendered.canvas);setRenderedIds(idle.rendered.result.renderedEditIds);
      settledKeyRef.current=idle.key;setState('committed');
    } else if (originalRef.current) {
      swap(originalRef.current);setRenderedIds(EMPTY_IDS);settledKeyRef.current=undefined;
    }
    setSelection(undefined);setReason(undefined);
  }, [swap]);
  const commit = useCallback((close:()=>void)=>{
    controller.current.invalidate();closeCommitRef.current=close;setState('committing');
  }, []);

  useEffect(() => {
    if (!activeInfo || !originalRef.current) return;
    if (selection && !closeCommitRef.current && selectionContentRef.current !== contentKey) {
      invalidateEditorRef.current?.();cancel();return;
    }
    const finishCommit = () => {
      const close = closeCommitRef.current;
      if (close) {closeCommitRef.current=undefined;setSelection(undefined);close();}
    };
    if (blocked || (!selection && pageEdits.length===0) || !document || (!near && !selection)) {
      settledKeyRef.current = undefined;
      controller.current.invalidate();swap(originalRef.current);setRenderedIds(EMPTY_IDS);
      setState(blocked && pageEdits.length ? 'fallback' : 'original');finishCommit();return;
    }
    const active = closeCommitRef.current ? undefined : selection;
    const key = `${idleKey}:${active ? `edit:${active.key}` : 'idle'}`;
    // Closing the retained editor after a swap must not retry a failed render.
    if (settledKeyRef.current === key) return;
    const currentController = controller.current;
    setState(active ? 'preparing-edit' : 'committing');
    void currentController.request(key,()=>produceRef.current(active),(rendered)=>{
      settledKeyRef.current = key;
      if (!active) idlePreviewRef.current={key,rendered};
      swap(rendered.canvas);setRenderedIds(rendered.result.renderedEditIds);setReason(undefined);
      setState(active ? 'editing' : 'committed');finishCommit();
    },(error)=>{
      settledKeyRef.current = key;
      swap(originalRef.current!);setRenderedIds(EMPTY_IDS);setState('fallback');
      setReason(error instanceof Error ? error.message : String(error));finishCommit();
    });
    return () => currentController.invalidate();
    // Page work is keyed by this page's content; another page and typing do not trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInfo,idleKey,selection,blocked,near,document,cancel,swap]);

  const bridge:PagePreviewBridge = {state,renderedEditIds:renderedIds,reason,begin,warm,cancel,commit,suspend:setSuspended};
  return <div ref={containerRef} className="relative overflow-hidden bg-white shadow-md"
    data-preview-state={state} data-preview-reason={reason} style={{width:cssWidth,height:cssHeight}}>
    <canvas ref={canvasRef} className="block" style={{width:cssWidth,height:cssHeight}} />
    {activeInfo && <OverlayLayer page={page} pageIndex={pageIndex} viewport={activeInfo.viewport} dpr={activeInfo.dpr}
      zoom={zoom} editMode={editMode} textAddMode={textAddMode} imageMode={imageMode} peek={peek}
      locations={locations} locationNames={locationNames} preview={bridge} />}
  </div>;
}
