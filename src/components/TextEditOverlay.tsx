import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TextEdit, TextStyle } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { ScreenRect } from '@/lib/export/coordinates';
import { textBlockLineHeight } from '@/lib/edit/buildTextEdits';
import type { NextTextEdit } from '@/lib/edit/buildTextEdits';
import { textStyleToCss } from '@/lib/edit/textStyleCss';
import { classifyFontFamily } from '@/lib/pdf/textContent';

const FAMILY_KEYWORD = {
  sans: 'Arial',
  serif: 'Times New Roman',
  mono: 'Courier New',
} as const;

const MIN_BOX_WIDTH = 12;
const MIN_BOX_HEIGHT = 8;

interface TextEditOverlayProps {
  readonly block: TextBlock;
  readonly existing?: readonly TextEdit[];
  readonly screenRect: ScreenRect;
  readonly zoom: number;
  onDone(next: NextTextEdit): void;
  onCancel(): void;
}

export function TextEditOverlay({
  block,
  existing,
  screenRect,
  zoom,
  onDone,
  onCancel,
}: TextEditOverlayProps) {
  const initialText = existing?.[0]?.boxText ?? existing?.map((edit) => edit.text).join('\n') ?? block.text;
  const initialStyle = existing?.[0]?.style ?? block.style;
  const [text, setText] = useState(initialText);
  const [style, setStyle] = useState<TextStyle>(initialStyle);
  const naturalWidth = block.rect.w;
  const [width, setWidth] = useState(Math.max(existing?.[0]?.rect.w ?? naturalWidth, naturalWidth));
  const [height, setHeight] = useState(Math.max(existing?.[0]?.boxHeight ?? block.rect.h, MIN_BOX_HEIGHT));
  const [moveOffset, setMoveOffset] = useState({ x: 0, y: 0 });
  const editableRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const editable = editableRef.current;
    if (!editable) return;
    editable.focus();
    editable.selectionStart = editable.value.length;
    editable.selectionEnd = editable.value.length;
  }, []);

  const beginWidthDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    event.currentTarget.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      setWidth(Math.max(MIN_BOX_WIDTH, startWidth + (moveEvent.clientX - startX) / zoom));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  const beginMoveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = moveOffset;
    event.currentTarget.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      setMoveOffset({
        x: startOffset.x + moveEvent.clientX - startX,
        y: startOffset.y + moveEvent.clientY - startY,
      });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  const commit = () => {
    onDone({
      text: text.replace(/\r\n?/g, '\n'),
      style,
      width,
      height,
      dx: moveOffset.x / zoom,
      dy: -moveOffset.y / zoom,
    });
  };
  const controlsAbove = screenRect.top + moveOffset.y > 52;
  const lineHeight = textBlockLineHeight(block, style);
  const resizeToContent = useCallback(() => {
    const textarea = editableRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    const contentHeight = Math.max(lineHeight * zoom, textarea.scrollHeight);
    textarea.style.height = `${contentHeight}px`;
    setHeight(contentHeight / zoom);
  }, [lineHeight, zoom]);

  useLayoutEffect(() => {
    resizeToContent();
  }, [resizeToContent, style, text, width]);

  return (
    <div
      className="absolute z-50"
      style={{
        left: screenRect.left + moveOffset.x,
        top: screenRect.top + moveOffset.y,
        width: width * zoom,
        height: height * zoom,
      }}
    >
      <div
        className={`absolute left-0 flex items-center gap-1 rounded-lg border border-neutral-300 bg-white p-1 shadow-xl ${controlsAbove ? 'bottom-full mb-2' : 'top-full mt-2'}`}
        role="toolbar"
        aria-label="Text formatting"
      >
        <button type="button" onClick={() => setStyle((value) => ({ ...value, fontSizePt: Math.max(4, value.fontSizePt - 1) }))} className="rounded px-2 py-1 text-sm hover:bg-neutral-100" aria-label="Decrease text size">A−</button>
        <button type="button" onClick={() => setStyle((value) => ({ ...value, fontSizePt: value.fontSizePt + 1 }))} className="rounded px-2 py-1 text-sm hover:bg-neutral-100" aria-label="Increase text size">A+</button>
        <button type="button" aria-pressed={style.bold} onClick={() => setStyle((value) => ({ ...value, bold: !value.bold }))} className={`rounded px-2 py-1 text-sm font-bold ${style.bold ? 'bg-blue-100 text-blue-800' : 'hover:bg-neutral-100'}`}>B</button>
        <button type="button" aria-pressed={style.italic} onClick={() => setStyle((value) => ({ ...value, italic: !value.italic }))} className={`rounded px-2 py-1 text-sm italic ${style.italic ? 'bg-blue-100 text-blue-800' : 'hover:bg-neutral-100'}`}>I</button>
        <select
          aria-label="Font family"
          value={classifyFontFamily(style.fontName)}
          onChange={(event) => {
            const family = event.target.value as keyof typeof FAMILY_KEYWORD;
            setStyle((value) => ({ ...value, fontName: FAMILY_KEYWORD[family] }));
          }}
          className="rounded border border-neutral-200 bg-white px-1 py-1 text-sm"
        >
          <option value="sans">Sans</option>
          <option value="serif">Serif</option>
          <option value="mono">Mono</option>
        </select>
        <span className="mx-1 h-5 w-px bg-neutral-200" />
        <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100">Cancel</button>
        <button type="button" onClick={commit} className="rounded bg-neutral-900 px-2 py-1 text-sm font-medium text-white hover:bg-neutral-700">Done</button>
      </div>

      <textarea
        ref={editableRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Editable text"
        rows={1}
        spellCheck={false}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') commit();
          if (event.key === 'Escape') onCancel();
        }}
        className="block w-full resize-none overflow-hidden whitespace-pre-wrap rounded-sm border-0 bg-transparent p-0 outline outline-2 outline-blue-500"
        style={{ ...textStyleToCss(style, zoom), lineHeight: `${lineHeight * zoom}px` }}
      />
      <button
        type="button"
        aria-label="Drag to change text width"
        onPointerDown={beginWidthDrag}
        className="absolute -right-2 top-0 h-full w-4 cursor-ew-resize rounded bg-blue-500/80 hover:bg-blue-600"
      />
      <button
        type="button"
        aria-label="Drag to move text"
        title="Drag to move text; arrow keys move one pixel"
        onPointerDown={beginMoveDrag}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          const delta = {
            ArrowLeft: { x: -step, y: 0 },
            ArrowRight: { x: step, y: 0 },
            ArrowUp: { x: 0, y: -step },
            ArrowDown: { x: 0, y: step },
          }[event.key];
          if (!delta) return;
          event.preventDefault();
          setMoveOffset((value) => ({ x: value.x + delta.x, y: value.y + delta.y }));
        }}
        className="absolute -left-3 -top-3 h-6 w-6 cursor-move rounded-full border-2 border-white bg-blue-600 text-xs font-bold leading-none text-white shadow hover:bg-blue-700"
      >
        ✥
      </button>
    </div>
  );
}
