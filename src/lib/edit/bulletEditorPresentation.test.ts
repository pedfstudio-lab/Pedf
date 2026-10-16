// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { bulletEditorHtml, canonicalBulletValue, insertBulletItems, refreshBulletEditorLayout } from './bulletEditorPresentation';
import { serializeRichText } from './richText';
const style={fontName:'Calibri',fontIdentity:'Calibri',fontSizePt:12,bold:false,italic:false,color:{r:0,g:0,b:0}};
describe('list column presentation, not bullet layout',()=>{
  it('Enter splits one item into sibling items, keeps the tail and places the caret after the new marker',()=>{
    const root=document.createElement('div');root.innerHTML=bulletEditorHtml('• First tail\n• Next',style,undefined,1,20);document.body.append(root);
    const first=root.children[0]!;const word=[...first.querySelectorAll('[data-pdf-font-word]')].find(s=>s.textContent==='First')!.firstChild!;
    const range=document.createRange();range.setStart(word,5);range.collapse(true);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);
    expect(insertBulletItems(root,'\n',style,1,20,3)).toBe(true);
    refreshBulletEditorLayout(root,20,3,1);
    expect(root.children).toHaveLength(3);
    expect(canonicalBulletValue(serializeRichText(root,style)).text).toBe('• First\n•  tail\n• Next');
    expect((root.children[1] as HTMLElement).style.paddingLeft).toBe('20px');
    expect(root.style.tabSize).toBe('20px');
    expect(root.children[1]!.contains(window.getSelection()!.anchorNode)).toBe(true);
    root.remove();
  });
  it('multiline paste produces aligned items, keeping the same parsed item text',()=>{
    const root=document.createElement('div');root.innerHTML=bulletEditorHtml('➢ First',style,undefined,1,29);document.body.append(root);
    const range=document.createRange();range.selectNodeContents(root.children[0]!);range.collapse(false);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);
    expect(insertBulletItems(root,' end\nSecond\nThird',style,1,29,4,'➢ ')).toBe(true);
    expect(canonicalBulletValue(serializeRichText(root,style)).text).toBe('➢ First end\n➢ Second\n➢ Third');
    expect(root.children).toHaveLength(3);
    expect([...root.children].map(row=>(row as HTMLElement).style.textIndent)).toEqual(['-29px','-29px','-29px']);
    root.remove();
  });
  it('uses one native text transaction, leaving splitting, selection and undo to the browser',()=>{
    const root=document.createElement('div');root.textContent='➢ First';document.body.append(root);
    const range=document.createRange();range.selectNodeContents(root);range.collapse(false);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);
    const command=vi.fn(()=>true);Object.defineProperty(document,'execCommand',{configurable:true,value:command});
    try {
      expect(insertBulletItems(root,'\r\nSecond\r\n• Third',style,1,29,4,'➢ ')).toBe(true);
      expect(command).toHaveBeenCalledTimes(1);
      expect(command).toHaveBeenCalledWith('insertText',false,'\n➢\tSecond\n➢\tThird');
      expect(root.textContent).toBe('➢ First');
    } finally {delete (document as Partial<Document>).execCommand;root.remove();}
  });
  it('canonicalizes only marker-column tabs, preserving body tabs and inline styles',()=>{
    const value={text:'•\tBold\tword\n➢\tNext',style,spans:[{text:'•\t',bold:false,italic:false},{text:'Bold\tword',bold:true,italic:false},{text:'\n➢\tNext',bold:false,italic:false}]};
    const result=canonicalBulletValue(value);
    expect(result.text).toBe('• Bold\tword\n➢ Next');
    expect(result.spans?.map(span=>span.text).join('')).toBe(result.text);
    expect(result.spans?.[1]).toEqual(value.spans[1]);
    const untouched={text:'• Ordinary\tbody',style};
    expect(canonicalBulletValue(untouched)).toBe(untouched);
  });
  it('reserves the existing marker indent on every row and the existing item gap',()=>{
    const root=document.createElement('div'); root.innerHTML=bulletEditorHtml('➢ First item\n➢ Second item',style,undefined,2,29);
    refreshBulletEditorLayout(root,29,4.5,2);
    const items=[...root.children] as HTMLElement[];
    expect(items.map(item=>item.style.paddingLeft)).toEqual(['58px','58px']);
    expect(items.map(item=>item.style.textIndent)).toEqual(['-58px','-58px']);
    expect(items.map(item=>item.style.marginTop)).toEqual(['0px','9px']);
    expect([...root.querySelectorAll<HTMLElement>('[data-pdf-bullet-prefix]')].map(prefix=>prefix.style.width)).toEqual(['58px','58px']);
    expect(serializeRichText(root,style,2).text).toBe('➢ First item\n➢ Second item');
  });
  it('keeps inline formatting, literal text and live nodes during attribute refresh',()=>{
    const root=document.createElement('div');
    const text='• A bold item\n• Next';
    root.innerHTML=bulletEditorHtml(text,style,[{text:'• A ',bold:false,italic:false},{text:'bold',bold:true,italic:false},{text:' item\n• Next',bold:false,italic:false}],1,20);
    document.body.append(root);
    const node=root.querySelector('[data-pdf-font-word]')!.firstChild!;
    const range=document.createRange(); range.selectNodeContents(node); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    refreshBulletEditorLayout(root,20,3,1);
    expect(root.querySelector('[data-pdf-font-word]')!.firstChild).toBe(node);
    expect(window.getSelection()?.anchorNode).toBe(node);
    const value=serializeRichText(root,style);
    expect(value.text).toBe(text); expect(value.spans?.find(span=>span.text==='bold')?.bold).toBe(true);
    root.remove();
  });
});
