import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedDocument } from './loadDocument';
import type { PagePreviewRequest, PagePreviewResult } from '@/lib/export/exportPagePreview';
import { acquirePagePreviewService, PagePreviewService } from './pagePreviewService';
const mocks=vi.hoisted(()=>({prepare:vi.fn(async()=>({})),dispose:vi.fn(),export:vi.fn(),workers:[] as FakeWorker[]}));
vi.mock('@/lib/export/exportPagePreview',()=>({PagePreviewSource:class {prepare=mocks.prepare;dispose=mocks.dispose;},exportPagePreview:mocks.export}));
class FakeWorker {
  onmessage?: (event:MessageEvent)=>void;onerror?:()=>void;
  messages:Record<string,unknown>[]=[];terminate=vi.fn();auto=true;
  constructor(){mocks.workers.push(this);}
  postMessage(message:Record<string,unknown>){this.messages.push(message);if(this.auto) queueMicrotask(()=>this.onmessage?.({data:{id:message.id,result:message.request?result:undefined}} as MessageEvent));}
}
const result:PagePreviewResult={bytes:new Uint8Array([9]),clean:true,warnings:[],renderedEditIds:new Set(),satisfiedCoverIds:new Set(),timings:{sourceMs:0,rewriteMs:0}};
const loaded={originalBytes:new Uint8Array([1,2,3]),doc:{getPage:async()=>({commonObjs:{has:()=>false}})},pages:[]} as unknown as LoadedDocument;
const request:PagePreviewRequest={document:{originalBytes:loaded.originalBytes,pages:[{pageIndex:0,widthPt:100,heightPt:100,rotation:0,boxOffset:{x:0,y:0}}],edits:[]},pageIndex:0};
beforeEach(()=>{vi.clearAllMocks();mocks.workers=[];vi.stubGlobal('Worker',FakeWorker);mocks.export.mockResolvedValue(result);});
afterEach(()=>vi.unstubAllGlobals());
describe('shared page preview service',()=>{
  it('starts lazily, transfers a copy once and deduplicates page preparation',async()=>{
    const service=new PagePreviewService(loaded);expect(mocks.workers).toHaveLength(0);
    await Promise.all([service.prepare(0),service.prepare(0),service.prepare(0)]);
    const worker=mocks.workers[0]!;
    expect(worker.messages.filter((message)=>message.bytes)).toHaveLength(1);
    expect(worker.messages.filter((message)=>message.sourceIndex===0)).toHaveLength(1);
    const bytes=worker.messages[0]!.bytes as Uint8Array;expect(bytes).toEqual(loaded.originalBytes);expect(bytes).not.toBe(loaded.originalBytes);
    expect(await service.export(request)).toBe(result);service.dispose();expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('falls back safely when worker construction is unavailable',async()=>{
    vi.stubGlobal('Worker',class {constructor(){throw new Error('Workers disabled');}});
    const service=new PagePreviewService(loaded);expect(await service.export(request)).toBe(result);
    expect(mocks.export).toHaveBeenCalledTimes(1);expect(service.workerEnabled).toBe(false);service.dispose();
  });
  it('does not reopen a closed document after pending worker work rejects',async()=>{
    const service=new PagePreviewService(loaded);await service.prepare(0);mocks.workers[0]!.auto=false;
    const pending=service.export(request);const assertion=expect(pending).rejects.toThrow('closed');
    await Promise.resolve();service.dispose();await assertion;expect(mocks.export).not.toHaveBeenCalled();
    await expect(service.prepare()).rejects.toThrow('closed');
  });
  it('shares a document source until the last user releases it, with idempotent release',()=>{
    const first=acquirePagePreviewService(loaded),second=acquirePagePreviewService(loaded);
    expect(first.service).toBe(second.service);first.release();first.release();expect(mocks.dispose).not.toHaveBeenCalled();
    second.release();expect(mocks.dispose).toHaveBeenCalledTimes(1);
    const reopened=acquirePagePreviewService(loaded);expect(reopened.service).not.toBe(first.service);reopened.release();
  });
});
