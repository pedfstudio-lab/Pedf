import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { EditDocument } from '@/lib/export/types';
import { pdfRectToScreenRect } from '@/lib/export/coordinates';
import { renderPage } from '@/lib/pdf/renderPage';
import { useDocumentStore } from '@/state/documentStore';
import { useEdits } from '@/state/editsStore';
import { planToGeometry } from '@/state/pagePlan';
import { useTranslation } from '@/state/translationStore';
import { editsIdentity, openCleanPage } from '@/lib/translate/cleanPages';
import { pageTranslationSelection, scriptFonts, translationError, translationScale } from '@/lib/translate/pageTranslation';
import type { TranslationBox } from '@/lib/translate/pageTranslation';
import { patchRect, translationPatch } from '@/lib/translate/translationPatch';
import type { TranslationPatch } from '@/lib/translate/translationPatch';

/** The clean page fades in over the patches the first time it is ready. */
const REVEAL_MS = 220;

function TranslatedBox({ box, text, language, viewport, dpr, zoom }: {
  readonly box: TranslationBox; readonly text: string; readonly language: string;
  readonly viewport: PageViewport; readonly dpr: number; readonly zoom: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const rect = pdfRectToScreenRect(box.rect, viewport, dpr);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    let cancelled = false;
    const measure = () => {
      const node = element.current;
      if (!node || cancelled) return;
      const value = translationScale(candidate => {
        node.style.fontSize = `${box.style.fontSizePt * zoom * candidate}px`;
        return node.scrollHeight <= rect.height + 1 && node.scrollWidth <= rect.width + 1;
      });
      node.style.fontSize = `${box.style.fontSizePt * zoom * value}px`;
      setScale(value);
    };
    measure();
    void window.document.fonts?.ready.then(measure);
    return () => { cancelled = true; };
  }, [text, language, box.style.fontSizePt, zoom, rect.width, rect.height]);
  const { r, g, b } = box.style.color;
  return <div ref={element} lang={language} data-translation-box={box.id} data-translation-scale={scale}
    className="absolute whitespace-pre-wrap bg-transparent" style={{ left: rect.left, top: rect.top,
      width: rect.width, fontSize: box.style.fontSizePt * zoom * scale, lineHeight: 1.25,
      fontFamily: scriptFonts[language], fontWeight: box.style.bold ? 700 : 400,
      fontStyle: box.style.italic ? 'italic' : 'normal', textAlign: box.align ?? 'left',
      overflowWrap: 'anywhere', color: `rgb(${r * 255},${g * 255},${b * 255})` }}>
    {box.prefix && <span data-translation-marker aria-hidden="true">{box.prefix} </span>}{text}
  </div>;
}

function patchStyle(box: TranslationBox, patch: TranslationPatch, viewport: PageViewport, dpr: number, zoom: number): CSSProperties {
  const rect = pdfRectToScreenRect(patchRect(box.rect, box.style.fontSizePt), viewport, dpr);
  const { r, g, b } = patch.color, rgb = `${r * 255},${g * 255},${b * 255}`;
  const frost = `blur(${Math.max(6, box.style.fontSizePt * zoom * 0.5)}px)`;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    ...(patch.look === 'solid' ? { background: `rgb(${rgb})` }
      : { background: `rgba(${rgb},0.4)`, backdropFilter: frost, WebkitBackdropFilter: frost }) };
}

/**
 * Screen-only replacement. The words show as soon as Sarvam returns them, on patches that hide
 * the English; the page with the English removed fades in over the patches once it is drawn.
 * A zoom keeps everything on screen (stretched) and only redraws the page underneath.
 */
export function TranslationLayer({ boxes, pageIndex, viewport, dpr, zoom, eligible, prefetch = false }: {
  readonly boxes: readonly TranslationBox[]; readonly pageIndex: number; readonly viewport: PageViewport;
  readonly dpr: number; readonly zoom: number; readonly eligible: boolean;
  /** The next page, translated ahead of scrolling: its requests wait behind the pages in view. */
  readonly prefetch?: boolean;
}) {
  const translation = useTranslation();
  const { document: opened, getPageCanvas } = useDocumentStore();
  const { edits, pagePlan } = useEdits();
  const canvas = useRef<HTMLCanvasElement>(null);
  const priority = useRef(0); priority.current = prefetch ? 1 : 0;
  const [retry, setRetry] = useState(0);
  const [words, setWords] = useState<{ key: string; source: typeof opened; text?: ReadonlyMap<string, string>; error?: string }>();
  const [background, setBackground] = useState<{ key: string; source: typeof opened; canvas?: HTMLCanvasElement; zoom?: number; failed?: boolean }>();
  const drawn = useRef(background); drawn.current = background;
  const [revealed, setRevealed] = useState<string>();
  const language = translation?.language ?? 'en-IN';
  const active = Boolean(translation && opened && language !== 'en-IN' && boxes.length);
  const signature = JSON.stringify(boxes.map(box => [box.id, box.text, box.rect, box.style, box.prefix]));
  const wordsKey = `${pageIndex}:${language}:${signature}`;
  const pageEdits = useMemo(() => edits.filter(edit => edit.pageIndex === pageIndex), [edits, pageIndex]);
  // No language and no zoom: one clean page serves every zoom and every language.
  const cleanKey = `${pageIndex}:${JSON.stringify(pagePlan[pageIndex] ?? null)}:${editsIdentity(pageEdits)}:${signature}`;
  const shownWords = words?.key === wordsKey && words.source === opened ? words : undefined;
  const shownBackground = background?.key === cleanKey && background.source === opened ? background : undefined;
  const wordsFailed = Boolean(shownWords?.error);

  useEffect(() => {
    if (!active || !eligible) return;
    const abort = new AbortController();
    void translation!.cache.translate(boxes, language, translation!.provider, abort.signal, () => priority.current)
      .then(text => { if (!abort.signal.aborted) setWords({ key: wordsKey, source: opened, text }); })
      .catch(error => { if (!abort.signal.aborted) setWords({ key: wordsKey, source: opened, error: translationError(error) }); });
    return () => abort.abort();
    // A stable box signature prevents editor hover state from making API requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, opened, wordsKey, eligible, retry, translation?.cache, translation?.provider]);

  // Runs alongside Sarvam rather than after it; a zoom only redraws the remembered clean page.
  useEffect(() => {
    if (!active || !eligible || wordsFailed) return;
    const last = drawn.current;
    if (last?.key === cleanKey && last.source === opened && last.canvas && last.zoom === zoom * dpr) return;
    const abort = new AbortController();
    let task: ReturnType<typeof renderPage>['task'] | undefined;
    const draw = async () => {
      const page = await translation!.cleanPages.get(cleanKey, () => {
        const omit = new Set(boxes.flatMap(box => box.omitTextIds ?? []));
        const document: EditDocument = { originalBytes: opened!.loaded.originalBytes,
          pages: planToGeometry(pagePlan, opened!.loaded.pages), plan: pagePlan,
          edits: edits.filter(edit => !omit.has(edit.id)) };
        return openCleanPage(opened!.loaded, { document, pageIndex, selection: pageTranslationSelection(boxes) });
      });
      abort.signal.throwIfAborted();
      const offscreen = window.document.createElement('canvas');
      task = renderPage(page, offscreen, zoom).task;
      await task.promise;
      if (!abort.signal.aborted) setBackground({ key: cleanKey, source: opened, canvas: offscreen, zoom: zoom * dpr });
    };
    // Unsafe removal keeps the patches: the words stay readable, the English stays hidden.
    void draw().catch(() => {
      if (!abort.signal.aborted) setBackground(current => current?.key === cleanKey && current.source === opened && current.canvas
        ? current : { key: cleanKey, source: opened, failed: true });
    });
    return () => { abort.abort(); task?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, opened, cleanKey, zoom, dpr, eligible, retry, wordsFailed, translation?.cleanPages]);

  const ready = Boolean(shownWords?.text && shownBackground?.canvas);
  useLayoutEffect(() => {
    const target = canvas.current, source = shownBackground?.canvas;
    if (!target || !source) return;
    target.width = source.width; target.height = source.height;
    target.getContext('2d')?.drawImage(source, 0, 0);
    if (revealed === cleanKey) return;
    const key = cleanKey, done = () => setRevealed(key);
    if (typeof target.animate !== 'function') { done(); return; }
    const fade = target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REVEAL_MS, easing: 'ease-out' });
    void fade.finished.then(done, done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, shownBackground?.canvas]);

  const showPatches = revealed !== cleanKey || !shownBackground?.canvas;
  // Laid out at the zoom of the page's last render; a newer zoom stretches it until the page redraws.
  const layoutZoom = viewport.scale ? viewport.scale / dpr : zoom;
  const stretch = zoom / layoutZoom;
  const registration = shownWords?.text && showPatches ? getPageCanvas?.(pageIndex) : undefined;
  const patches = useMemo(() => shownWords?.text && showPatches
    ? boxes.map(box => translationPatch(registration?.canvas, registration?.viewport,
      box.rect, box.style.fontSizePt, box.style.color)) : [],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [Boolean(shownWords?.text), showPatches, signature, registration?.canvas]);

  if (!translation || language === 'en-IN' || !boxes.length) return null;
  if (!shownWords?.text) return eligible ? <div role="status" className="pointer-events-auto absolute left-2 top-2 z-30 max-w-sm rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-950 shadow">
    {shownWords?.error ?? 'Translating this page…'}
    {shownWords?.error && <button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>Try again</button>}
  </div> : null;
  return <div className="pointer-events-none absolute inset-0 z-20" aria-label={`Page ${pageIndex + 1} translation`}>
    <div className="absolute left-0 top-0" style={{ width: viewport.width / dpr, height: viewport.height / dpr,
      ...(Math.abs(stretch - 1) > 1e-6 ? { transform: `scale(${stretch})`, transformOrigin: '0 0' } : {}) }}>
      {showPatches && boxes.map((box, index) => patches[index] && <div key={box.id} aria-hidden="true"
        data-translation-patch={patches[index]!.look} className="absolute"
        style={patchStyle(box, patches[index]!, viewport, dpr, layoutZoom)} />)}
      {shownBackground?.canvas && <canvas ref={canvas} aria-hidden="true" data-translation-page
        className="absolute inset-0" style={{ width: viewport.width / dpr, height: viewport.height / dpr }} />}
      {boxes.map(box => <TranslatedBox key={box.id} box={box} text={shownWords.text!.get(box.id) ?? ''}
        language={language} viewport={viewport} dpr={dpr} zoom={layoutZoom} />)}
    </div>
  </div>;
}
