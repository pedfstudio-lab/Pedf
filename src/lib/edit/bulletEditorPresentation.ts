import type { TextSpan, TextStyle } from '@/lib/export/types';
import { effectiveTextSpans, richTextToHtml, splitParagraphSpans } from './richText';
import type { SerializedRichText } from './richText';

function slice(spans: readonly TextSpan[], start: number, end: number): TextSpan[] {
  let offset = 0;
  return spans.flatMap(span => {
    const from = Math.max(0, start - offset), to = Math.min(span.text.length, end - offset); offset += span.text.length;
    return to > from ? [{ ...span, text: span.text.slice(from,to) }] : [];
  });
}

function bulletPrefixHtml(prefix: string, style: TextStyle, zoom: number, indent: number): string {
  return '<span data-pdf-bullet-prefix="true" style="display:inline-block;width:'+indent*zoom+'px;text-indent:0;white-space:pre">'+richTextToHtml(prefix,style,undefined,zoom)+'</span>';
}

/** Presentation only: the existing bullet parser/wrapper remains authoritative. */
export function bulletEditorHtml(text: string, style: TextStyle, spans: readonly TextSpan[] | undefined, zoom: number, indent: number): string {
  const parts = splitParagraphSpans(effectiveTextSpans(text,style,spans));
  return text.split('\n').map((line,index) => {
    const prefix = line.match(/^\s*[•➢\uF0D8]\s*/u)?.[0] ?? '';
    const body = richTextToHtml(line.slice(prefix.length),style,slice(parts[index] ?? [],prefix.length,line.length),zoom);
    return '<div data-pdf-paragraph="true" data-pdf-bullet-item="true">'+(prefix ? bulletPrefixHtml(prefix,style,zoom,indent) : '')+(body || (prefix ? '' : '<br>'))+'</div>';
  }).join('');
}

/** Attributes only during ordinary input, preserving native nodes/selection/undo. */
export function refreshBulletEditorLayout(root: HTMLElement, indent: number, itemSpacing: number, zoom: number): void {
  // A display-only tab reserves the same marker column as the source prefix.
  root.style.tabSize = indent * zoom+'px';
  [...root.children].forEach((element,index) => {
    if (!(element instanceof HTMLElement) || !['DIV','P'].includes(element.tagName)) return;
    element.dataset.pdfParagraph = 'true'; element.dataset.pdfBulletItem = 'true';
    element.style.paddingLeft = indent * zoom+'px';
    element.style.textIndent = -indent * zoom+'px';
    element.style.marginTop = (index ? itemSpacing * zoom : 0)+'px';
    for (const prefix of element.querySelectorAll<HTMLElement>('[data-pdf-bullet-prefix]')) prefix.style.width = indent * zoom+'px';
  });
}

/** Display tabs serialize to exactly the same marker-space text as before. */
export function canonicalBulletValue(value: SerializedRichText): SerializedRichText {
  const offsets = new Set<number>();
  for (const match of value.text.matchAll(/(?:^|\n)[•➢\uF0D8]\t/gu)) offsets.add(match.index + match[0].length - 1);
  if (!offsets.size) return value;
  let offset = 0;
  const replace = (text: string) => text.split('').map(character => offsets.has(offset++) ? ' ' : character).join('');
  const text = replace(value.text); offset = 0;
  return { ...value, text, ...(value.spans ? { spans:value.spans.map(span=>({...span,text:replace(span.text)})) } : {}) };
}

/** One native insertText transaction: Chrome owns item splitting and Undo. */
export function insertBulletItems(root: HTMLElement, text: string, style: TextStyle, zoom: number, indent: number, itemSpacing: number, prefix = '• '): boolean {
  const doc=root.ownerDocument, selection=doc.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.getRangeAt(0).commonAncestorContainer)) return false;
  const symbol=prefix.match(/[•➢\uF0D8]/u)?.[0] ?? '•';
  const inserted=text.replace(/\r\n?/g,'\n').split('\n').map((line,index)=>index ? symbol+'\t'+line.replace(/^\s*[•➢\uF0D8]\s*/u,'') : line).join('\n');
  if (typeof doc.execCommand==='function' && doc.execCommand('insertText',false,inserted)) return true;
  // jsdom/non-native fallback; the previous manual insertion also had no undo.
  const caret=selection.getRangeAt(0);
  let item=caret.startContainer.nodeType===1 ? caret.startContainer as HTMLElement : caret.startContainer.parentElement;
  while(item && item.parentElement!==root)item=item.parentElement;
  if(!item || !item.contains(caret.endContainer))return false;
  const before=doc.createRange();before.selectNodeContents(item);before.setEnd(caret.startContainer,caret.startOffset);
  const after=doc.createRange();after.selectNodeContents(item);after.setStart(caret.endContainer,caret.endOffset);
  const host=doc.createElement('div');
  const parts=inserted.split('\n');
  parts.forEach((part,index)=>{
    const row=doc.createElement('div');row.dataset.pdfParagraph='true';
    if(!index)row.append(before.cloneContents());
    row.insertAdjacentHTML('beforeend',richTextToHtml(part,style,undefined,zoom));
    if(index===parts.length-1){const anchor=doc.createElement('span');anchor.dataset.pdfBulletCaret='true';row.append(anchor,after.cloneContents());}
    host.append(row);
  });
  item.replaceWith(...host.childNodes);
  const anchor=root.querySelector('[data-pdf-bullet-caret]');
  if(anchor){const next=doc.createRange();next.setStartBefore(anchor);next.collapse(true);selection.removeAllRanges();selection.addRange(next);anchor.remove();}
  refreshBulletEditorLayout(root,indent,itemSpacing,zoom);
  return true;
}
