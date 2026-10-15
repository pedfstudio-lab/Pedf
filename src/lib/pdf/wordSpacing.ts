import { OPS, type PDFPageProxy } from 'pdfjs-dist';
import type { TextLine } from './textContent';

export interface RawSpacing {normalSpacePt:number|null;charSpacingPt:number;spaces:{left:string;right:string;gapPt:number;normalSpacePt:number|null;excessPt:number|null}[];unmeasured:number}
export function runKey(font:string,text:string,x:number,y:number) {return JSON.stringify([font,text,x.toFixed(4),y.toFixed(4)]);}
export async function rawSpacing(page:PDFPageProxy):Promise<Map<string,RawSpacing>> {
  const [content,operators] = await Promise.all([page.getTextContent(),page.getOperatorList()]);
  let state = {font:'',size:1,tc:0,tw:0}; const stack:typeof state[] = [];
  const glyphs:{char:string;font:string;beforeEm:number;tcEm:number;widthEm:number;valid:boolean}[] = [];
  const spaceWidths = new Map<string,number>(); let pendingEm = 0;
  const collect = (entry:unknown) => {
    if (Array.isArray(entry)) {entry.forEach(collect);return;}
    if (typeof entry === 'number') {pendingEm -= entry / 1000;return;}
    if (!entry || typeof entry !== 'object') return;
    const glyph = entry as {unicode?:string;width?:number};
    if (typeof glyph.unicode !== 'string' || typeof glyph.width !== 'number') return;
    const tcEm = state.tc / Math.abs(state.size || 1);
    if (/^\s+$/u.test(glyph.unicode)) {
      if (glyph.unicode === ' ') spaceWidths.set(state.font,glyph.width);
      pendingEm += glyph.width / 1000 + tcEm + state.tw / Math.abs(state.size || 1); return;
    }
    const characters=[...glyph.unicode.normalize('NFKC')];
    characters.forEach((char,index) => glyphs.push({char,font:state.font,beforeEm:index ? 0 : pendingEm,tcEm:index ? 0 : tcEm,widthEm:index ? 0 : glyph.width!/1000,valid:characters.length===1}));
    pendingEm = 0;
  };
  operators.fnArray.forEach((op,index) => {const args=operators.argsArray[index] ?? [];
    if (op===OPS.save || op===OPS.paintFormXObjectBegin) stack.push({...state});
    else if (op===OPS.restore || op===OPS.paintFormXObjectEnd) state=stack.pop() ?? state;
    else if (op===OPS.setFont) state={...state,font:args[0],size:args[1]};
    else if (op===OPS.setCharSpacing) state={...state,tc:args[0]};
    else if (op===OPS.setWordSpacing) state={...state,tw:args[0]};
    else if (op===OPS.nextLineSetSpacingShowText) {state={...state,tw:args[0],tc:args[1]};collect(args.at(-1));return;}
    if ([OPS.showText,OPS.showSpacedText,OPS.nextLineShowText].includes(op)) collect(args[0]);
  });
  let cursor=0, mismatch=false; const result=new Map<string,RawSpacing>();
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const scale=Math.hypot(item.transform[0]!,item.transform[1]!);
    const font=page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : undefined;
    const rawSpace=spaceWidths.get(item.fontName) ?? font?.spaceWidth;
    // Only an ordinary horizontal advance matrix is accepted. Type3 alone
    // isn't a rejection: its measured advances can still be valid. The trace
    // must also reproduce the extracted run width before its gaps are used.
    const matrix=font?.fontMatrix;
    const supported=!font?.vertical && Math.abs(item.transform[1]!)<0.001 && Math.abs(item.transform[2]!)<0.001
      && (!matrix || Math.abs(matrix[0]-0.001)<0.000001);
    const normal=supported && typeof rawSpace==='number' && rawSpace>0 ? rawSpace*scale/1000 : null;
    let previous:typeof glyphs[number]|undefined, whites=0, unmeasured=0; const spaces:RawSpacing['spaces']=[];
    let charSpacingPt=0,predictedEm=0,glyphCount=0;
    for (const char of [...item.str]) {
      if (/\s/u.test(char)) {whites++;continue;}
      const glyph=glyphs[cursor++];
      if (!glyph || glyph.char!==char) mismatch=true;
      if(glyph) {predictedEm+=glyph.widthEm+glyph.tcEm+(glyphCount ? glyph.beforeEm : 0);glyphCount++;}
      if (whites && previous) {
        if (!mismatch && supported && glyph?.valid && previous.valid && glyph.font===item.fontName && previous.font===item.fontName) {
          const gap=(glyph.beforeEm+previous.tcEm)*scale;
          spaces.push({left:previous.char,right:char,gapPt:gap,normalSpacePt:normal,excessPt:normal===null ? null : gap-normal});
        } else unmeasured++;
      }
      whites=0;previous=glyph;if(glyph)charSpacingPt=Math.max(charSpacingPt,Math.abs(glyph.tcEm*scale));
    }
    const actualInteriorSpaces=(item.str.trim().match(/\s+/g) ?? []).length;
    const validated=!mismatch && Math.abs(predictedEm*scale-item.width)<=0.1;
    result.set(runKey(item.fontName,item.str,item.transform[4]!,item.transform[5]!),{normalSpacePt:normal,charSpacingPt,
      spaces:validated ? spaces : [],unmeasured:validated ? unmeasured : actualInteriorSpaces});
  }
  return result;
}
export function wordGaps(line: TextLine,raw:ReadonlyMap<string,RawSpacing>) {
  const ordered = [...line.runs].sort((a,b) => a.rect.x - b.rect.x);
  const measured: {left:string;right:string;gapPt:number;normalSpacePt:number|null;excessPt:number|null}[] = [];
  let internalSpaces = 0,unmeasuredInternalSpaces=0,charSpacingPt=0;
  let cursor = 0;
  for (const [index, run] of ordered.entries()) {
    internalSpaces += (run.text.trim().match(/\s+/g) ?? []).length;
    const metric=raw.get(runKey(run.style.fontRef ?? '',run.text,run.rect.x,run.rect.y));
    if(metric) {measured.push(...metric.spaces);unmeasuredInternalSpaces+=metric.unmeasured;charSpacingPt=Math.max(charSpacingPt,metric.charSpacingPt);}
    else unmeasuredInternalSpaces+=(run.text.trim().match(/\s+/g) ?? []).length;
    const next = ordered[index + 1]; if (!next) continue;
    const left = run.text.trim(), right = next.text.trim();
    const start = line.text.indexOf(left,cursor); if (start < cursor) continue;
    cursor = start + left.length;
    const nextStart = line.text.indexOf(right,cursor);
    if (!left || !right || nextStart < cursor || !/\s/.test(line.text.slice(cursor,nextStart))) continue;
    const nextMetric=raw.get(runKey(next.style.fontRef ?? '',next.text,next.rect.x,next.rect.y));
    const normal = nextMetric?.normalSpacePt ?? metric?.normalSpacePt ?? undefined;
    const gap = next.rect.x - (run.rect.x + run.rect.w);
    measured.push({left:left.slice(-24),right:right.slice(0,24),gapPt:gap,normalSpacePt:normal ?? null,excessPt:normal === undefined ? null : gap - normal});
  }
  return {measured,internalSpaces,unmeasuredInternalSpaces,charSpacingPt};
}

