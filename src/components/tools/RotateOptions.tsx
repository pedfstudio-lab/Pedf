import { useEffect, useState } from 'react';
import { loadPdfJs } from '@/lib/tools/pdfIo';
import {
  describeTurns,
  parseRotateOptions,
  turnLeft,
  turnRight,
  type RotatePageSelection,
} from '@/lib/tools/rotateOptions';
import type { ToolOptionsProps } from '@/lib/tools/types';

type PreviewStatus = 'empty' | 'loading' | 'ready' | 'failed';

export function RotateOptions({ options, onChange, inputs, disabled }: ToolOptionsProps) {
  const value = parseRotateOptions(options);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('empty');
  const file = inputs[0];
  const update = (next: Partial<typeof value>) => onChange({ ...value, ...next });

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewStatus(file ? 'loading' : 'empty');
    if (!file) return;

    void (async () => {
      let loaded: Awaited<ReturnType<typeof loadPdfJs>> | undefined;
      let page: Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfJs>>['doc']['getPage']>> | undefined;
      let canvas: HTMLCanvasElement | undefined;
      try {
        loaded = await loadPdfJs(file);
        page = await loaded.doc.getPage(1);
        const natural = page.getViewport({ scale: 1 });
        const scale = 180 / Math.max(natural.width, natural.height);
        const viewport = page.getViewport({ scale });
        canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable.');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport, intent: 'print' }).promise;
        const image = canvas.toDataURL('image/png');
        if (!cancelled) {
          setPreview(image);
          setPreviewStatus('ready');
        }
      } catch {
        if (!cancelled) setPreviewStatus('failed');
      } finally {
        page?.cleanup();
        if (canvas) canvas.width = canvas.height = 0;
        if (loaded) await loaded.doc.destroy().catch(() => {});
      }
    })();

    return () => { cancelled = true; };
  }, [file]);

  const previewMessage = previewStatus === 'loading' ? 'Loading preview…'
    : previewStatus === 'failed' ? 'Preview unavailable'
      : 'Add a PDF to preview page 1';

  return <fieldset className="tool-options" disabled={disabled}>
    <legend>Rotate options</legend>
    <div className="rotate-workbench">
      <div className="rotate-preview" aria-busy={previewStatus === 'loading'}>
        {previewStatus === 'ready' && preview
          ? <img src={preview} alt="Page 1 preview" style={{
            transform: `rotate(${value.turns * 90}deg)`,
            transition: 'transform 200ms',
          }} />
          : <span>{previewMessage}</span>}
      </div>
      <div className="rotate-controls">
        <button type="button" className="rotate-turn-button" aria-label="Rotate left"
          onClick={() => update({ turns: turnLeft(value.turns) })}>↺ Left</button>
        <button type="button" className="rotate-turn-button" aria-label="Rotate right"
          onClick={() => update({ turns: turnRight(value.turns) })}>↻ Right</button>
        <span className="rotate-turn-label" aria-live="polite">{describeTurns(value.turns)}</span>
        {value.turns !== 0 && <button type="button" className="rotate-reset"
          onClick={() => update({ turns: 0 })}>Reset</button>}
      </div>
    </div>
    <div className="tool-option-details tool-page-selection">
      <label htmlFor="rotate-pages">Pages</label>
      <select id="rotate-pages" value={value.pageSelection}
        onChange={(event) => update({ pageSelection: event.target.value as RotatePageSelection })}>
        <option value="all">All pages</option>
        <option value="custom">Only these pages</option>
      </select>
      {value.pageSelection === 'custom' && <>
        <label htmlFor="rotate-ranges">Pages or ranges</label>
        <input id="rotate-ranges" type="text" inputMode="numeric" value={value.ranges}
          placeholder="1-3, 5, 8-10" onChange={(event) => update({ ranges: event.target.value })} />
        <p className="tool-hint">Use commas between pages or ranges.</p>
      </>}
    </div>
  </fieldset>;
}
