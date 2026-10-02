import { describe,expect,it,vi } from 'vitest';
import { PagePreviewController } from './pagePreviewController';
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
describe('page preview work',()=>{
  it('joins hover preparation and activation without producing a second page',async()=>{
    const controller=new PagePreviewController<number>(); const work=deferred<number>();const produce=vi.fn(()=>work.promise),accept=vi.fn();
    const warm=controller.warm('block',produce);const active=controller.request('block',produce,accept,vi.fn());
    work.resolve(7);await warm;await active;expect(produce).toHaveBeenCalledTimes(1);expect(accept).toHaveBeenCalledWith(7);
  });
  it('ignores older success and failure after another selection, zoom or document',async()=>{
    const controller=new PagePreviewController<number>();const old=deferred<number>(),current=deferred<number>();const accept=vi.fn(),fail=vi.fn();
    const first=controller.request('old',()=>old.promise,accept,fail);const second=controller.request('new',()=>current.promise,accept,fail);
    current.resolve(2);await second;old.reject(new Error('late failure'));await first;
    expect(accept.mock.calls).toEqual([[2]]);expect(fail).not.toHaveBeenCalled();
    const pending=deferred<number>();const cancelled=controller.request('cancelled',()=>pending.promise,accept,fail);
    controller.invalidate();pending.resolve(3);await cancelled;expect(accept).toHaveBeenCalledTimes(1);
  });
  it('bounds warmed work, releases eviction and permits retry after a failure',async()=>{
    const release=vi.fn();const controller=new PagePreviewController<number>(2,release);
    await controller.warm('a',async()=>1);await controller.warm('b',async()=>2);await controller.warm('c',async()=>3);
    await Promise.resolve();expect(release).toHaveBeenCalledWith(1);
    await expect(controller.warm('bad',async()=>{throw new Error('refused');})).rejects.toThrow('refused');
    expect(await controller.warm('bad',async()=>4)).toBe(4);controller.clear();await Promise.resolve();expect(release).toHaveBeenCalledWith(4);
  });
});
