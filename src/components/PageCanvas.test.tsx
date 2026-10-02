/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { Edit } from '@/lib/export/types';
import type { PagePreviewResult } from '@/lib/export/exportPagePreview';
import type { PagePreviewBridge } from '@/lib/pdf/pagePreviewController';
import { PageCanvas } from './PageCanvas';

const mocks = vi.hoisted(() => ({
  edits: [] as Edit[], bridge: undefined as PagePreviewBridge | undefined,
  export: vi.fn(), prepare: vi.fn(async () => undefined), release: vi.fn(),
  register: vi.fn(), destroy: vi.fn(async () => undefined), draw: vi.fn(),
  document: { loaded: { originalBytes: new Uint8Array([1]), pages: [{pageIndex:0,widthPt:600,heightPt:800,rotation:0,boxOffset:{x:0,y:0}}] } },
  plan: [{id:'page',kind:'source',sourceIndex:0}],
}));
vi.mock('@/state/documentStore', () => ({useDocumentStore: () => ({document:mocks.document,registerPageCanvas:mocks.register})}));
vi.mock('@/state/editsStore', () => ({useEdits: () => ({edits:mocks.edits,pagePlan:mocks.plan})}));
vi.mock('@/lib/pdf/pagePreviewService', () => ({acquirePagePreviewService: () => ({service:{export:mocks.export,prepare:mocks.prepare},release:mocks.release})}));
vi.mock('@/lib/pdf/renderPage', () => ({renderPage: (page: {preview?:boolean}, canvas:HTMLCanvasElement, zoom:number) => {
  canvas.width=600*zoom;canvas.height=800*zoom;canvas.style.width=`${600*zoom}px`;canvas.style.height=`${800*zoom}px`;
  canvas.dataset.surface=page.preview?'preview':'original';
  return {task:{promise:Promise.resolve(),cancel:vi.fn()}};
}}));
vi.mock('@/lib/pdf/worker', () => ({pdfjs:{getDocument: () => ({promise:Promise.resolve({getPage:async () => ({preview:true})}),destroy:mocks.destroy})}}));
vi.mock('./OverlayLayer', () => ({OverlayLayer: ({preview}:{preview:PagePreviewBridge}) => {mocks.bridge=preview;return null;}}));

const page = {getViewport: ({scale}:{scale:number}) => ({width:600*scale,height:800*scale})} as PDFPageProxy;
const props = {source:{kind:'pdf' as const,page},pageIndex:0,zoom:1,editMode:true,textAddMode:false,imageMode:false,peek:false,locations:[],locationNames:[]};
const selection = {key:'heading',transientEdits:[],coverIds:['cover'],omitTextIds:[],paintSupported:true};
const edit:Edit = {kind:'cover',id:'cover',pageIndex:0,z:0,rect:{x:10,y:10,w:30,h:20},color:{r:1,g:1,b:1},sampleBackground:false};
const result:PagePreviewResult = {bytes:new Uint8Array([1]),clean:true,warnings:[],renderedEditIds:new Set(['cover']),satisfiedCoverIds:new Set(['cover']),timings:{sourceMs:0,rewriteMs:0}};
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});return {promise,resolve,reject};}
beforeEach(() => {
  mocks.edits=[];mocks.bridge=undefined;vi.clearAllMocks();mocks.export.mockResolvedValue(result);
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:mocks.draw} as unknown as CanvasRenderingContext2D);
});
afterEach(() => {cleanup();vi.restoreAllMocks();});
async function open() {const view=render(<PageCanvas {...props}/>);await waitFor(()=>expect(mocks.bridge).toBeDefined());return view;}

describe('page preview presentation', () => {
  it('retains the current canvas until the clean page is ready and does no work for typing', async () => {
    const pending=deferred<PagePreviewResult>();mocks.export.mockReturnValue(pending.promise);
    const view=await open();const originalDraws=mocks.draw.mock.calls.length;
    act(()=>mocks.bridge!.begin(selection));
    expect(mocks.bridge!.state).toBe('preparing-edit');expect(mocks.draw).toHaveBeenCalledTimes(originalDraws);
    view.rerender(<PageCanvas {...props}/>);expect(mocks.export).toHaveBeenCalledTimes(1);
    await act(async()=>{pending.resolve(result);});
    await waitFor(()=>expect(mocks.bridge!.state).toBe('editing'));
    expect(mocks.draw.mock.lastCall?.[0].dataset.surface).toBe('preview');expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it('ignores a late selection after Cancel and restores the original pixels', async () => {
    const pending=deferred<PagePreviewResult>();mocks.export.mockReturnValue(pending.promise);await open();
    act(()=>mocks.bridge!.begin(selection));act(()=>mocks.bridge!.cancel());
    await act(async()=>{pending.resolve(result);});
    expect(mocks.bridge!.state).toBe('original');expect(mocks.draw.mock.lastCall?.[0].dataset.surface).toBe('original');expect(mocks.edits).toEqual([]);
  });
  it('restores the exact committed idle canvas on an unchanged close without exporting again', async () => {
    mocks.edits=[edit];await open();await waitFor(()=>expect(mocks.bridge!.state).toBe('committed'));
    const idle=mocks.draw.mock.lastCall?.[0];
    act(()=>mocks.bridge!.begin(selection));await waitFor(()=>expect(mocks.bridge!.state).toBe('editing'));
    const calls=mocks.export.mock.calls.length;act(()=>mocks.bridge!.cancel());
    expect(mocks.bridge!.state).toBe('committed');expect(mocks.draw.mock.lastCall?.[0]).toBe(idle);
    expect(mocks.export).toHaveBeenCalledTimes(calls);expect(mocks.edits).toEqual([edit]);
  });
  it('keeps the editor through commit and closes it only after the committed swap', async () => {
    const view=await open();act(()=>mocks.bridge!.begin(selection));await waitFor(()=>expect(mocks.bridge!.state).toBe('editing'));
    const pending=deferred<PagePreviewResult>();mocks.export.mockReturnValue(pending.promise);const close=vi.fn();
    act(()=>{mocks.bridge!.commit(close);mocks.edits=[edit];view.rerender(<PageCanvas {...props}/>);});
    expect(close).not.toHaveBeenCalled();expect(mocks.bridge!.state).toBe('committing');
    await act(async()=>{pending.resolve(result);});await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));
    expect(mocks.bridge!.state).toBe('committed');expect(mocks.bridge!.renderedEditIds.has('cover')).toBe(true);
  });
  it('retains the committed edit and reveals legacy overlays when rendering fails', async () => {
    const view=await open();act(()=>mocks.bridge!.begin(selection));await waitFor(()=>expect(mocks.bridge!.state).toBe('editing'));
    mocks.export.mockRejectedValue(new Error('Forced render refusal'));const close=vi.fn();
    act(()=>{mocks.bridge!.commit(close);mocks.edits=[edit];view.rerender(<PageCanvas {...props}/>);});
    await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));expect(mocks.bridge!.state).toBe('fallback');
    expect(mocks.bridge!.reason).toContain('Forced render refusal');expect(mocks.bridge!.renderedEditIds.size).toBe(0);expect(mocks.edits).toEqual([edit]);
  });
  it('rebuilds for zoom, ignores stale work, and leaves other-page changes alone', async () => {
    const first=deferred<PagePreviewResult>();mocks.export.mockReturnValueOnce(first.promise);const view=await open();
    act(()=>mocks.bridge!.begin(selection));view.rerender(<PageCanvas {...props} zoom={2}/>);
    await waitFor(()=>expect(mocks.bridge!.state).toBe('editing'));await act(async()=>{first.resolve(result);});
    expect(mocks.draw.mock.lastCall?.[0].width).toBe(1200);const calls=mocks.export.mock.calls.length;
    mocks.edits=[{...edit,pageIndex:1}];view.rerender(<PageCanvas {...props} zoom={2}/>);
    expect(mocks.export).toHaveBeenCalledTimes(calls);view.unmount();expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
