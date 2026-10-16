import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ensureMatchedFont, loadFontBytes, setFontByteLoader } from './twinFonts';
import { matchedCssFamily } from './fontMatch';
const read = async (file:string)=>new Uint8Array(await readFile(`public/fonts/${file}`));
afterEach(()=>{vi.unstubAllGlobals();setFontByteLoader(read);});
const style={fontName:'HelveticaNowText',fontIdentity:'HelveticaNowText',fontWidthScale:0.8,fontSizePt:12,bold:false,italic:false,color:{r:0,g:0,b:0}};
describe('lazy local font loading',()=>{
  it('caches the active asset and retries a failed load',async()=>{
    const loader=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Uint8Array([1,2,3]));
    setFontByteLoader(loader);
    await expect(loadFontBytes('carlito/Carlito-Regular.ttf')).rejects.toThrow('offline');
    const a=loadFontBytes('carlito/Carlito-Regular.ttf'),b=loadFontBytes('carlito/Carlito-Regular.ttf');
    expect(a).toBe(b);expect(await a).toEqual(new Uint8Array([1,2,3]));expect(loader).toHaveBeenCalledTimes(2);
  });
  it('registers one horizontally-variable browser face without resizing its height',async()=>{
    const constructors: {family:string;descriptors:FontFaceDescriptors}[]=[];
    class Face {
      constructor(family:string,_bytes:unknown,descriptors:FontFaceDescriptors){constructors.push({family,descriptors});}
      async load(){return this;}
    }
    const add=vi.fn(),loader=vi.fn(read);
    vi.stubGlobal('FontFace',Face);vi.stubGlobal('document',{fonts:{add}});setFontByteLoader(loader);
    await Promise.all([ensureMatchedFont(style),ensureMatchedFont(style)]);
    expect(loader).toHaveBeenCalledOnce();expect(loader).toHaveBeenCalledWith('r1width/R1WidthSans-Regular.ttf');
    expect(add).toHaveBeenCalledOnce();expect(constructors).toEqual([{family:matchedCssFamily(style),descriptors:{weight:'400',style:'normal',variationSettings:"'wdth' 80"}}]);
  });
  it('does not eagerly request any font in an export-only worker',async()=>{
    vi.stubGlobal('document',undefined);const loader=vi.fn(read);setFontByteLoader(loader);
    await ensureMatchedFont(style);expect(loader).not.toHaveBeenCalled();
  });
});
