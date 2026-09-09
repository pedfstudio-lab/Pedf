import { useEffect, useState } from 'react';
import { loadPdfJs } from '@/lib/tools/pdfIo';
import {
  dpiForQuality,
  pagePixelSize,
  parsePdfToJpgOptions,
  type PdfImageFormat,
  type PdfImageQuality,
  type PdfPageSelection,
} from '@/lib/tools/pdfToJpgOptions';
import type { ToolOptionsProps } from '@/lib/tools/types';

interface FirstPageSize { width: number; height: number }

export function PdfToJpgOptions({ options, onChange, inputs, disabled }: ToolOptionsProps) {
  const value = parsePdfToJpgOptions(options);
  const [firstPage, setFirstPage] = useState<FirstPageSize | null>(null);
  const [readingSize, setReadingSize] = useState(false);
  const file = inputs[0];
  const update = (next: Partial<typeof value>) => onChange({ ...value, ...next });

  useEffect(() => {
    let cancelled = false;
    setFirstPage(null);
    setReadingSize(!!file);
    if (!file) return;
    void loadPdfJs(file).then(async (loaded) => {
      try {
        const page = await loaded.doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        page.cleanup();
        if (!cancelled) setFirstPage({ width: viewport.width, height: viewport.height });
      } finally {
        await loaded.doc.destroy();
      }
    }).catch(() => {}).finally(() => { if (!cancelled) setReadingSize(false); });
    return () => { cancelled = true; };
  }, [file]);

  const dpi = dpiForQuality(value.quality);
  const pixels = firstPage ? pagePixelSize(firstPage.width, firstPage.height, dpi) : null;

  return <fieldset className="tool-options" disabled={disabled}>
    <legend>Image options</legend>
    <div className="tool-select-grid">
      <label className="tool-select-field">Format
        <select value={value.format} onChange={(event) => update({ format: event.target.value as PdfImageFormat })}>
          <option value="jpg">JPG - smaller, best for photos</option>
          <option value="png">PNG - lossless, sharp text</option>
        </select>
      </label>
      <label className="tool-select-field">Quality
        <select value={value.quality} onChange={(event) => update({ quality: event.target.value as PdfImageQuality })}>
          <option value="normal">Normal - 150 dpi</option>
          <option value="high">High - 300 dpi</option>
          <option value="small">Small - 72 dpi</option>
        </select>
      </label>
    </div>
    {file && <p className="tool-pixel-size" aria-live="polite">
      {pixels ? `Page 1 will be ${pixels.width} × ${pixels.height} px at ${dpi} dpi.`
        : readingSize ? 'Reading page 1 size…' : 'Page 1 size is unavailable.'}
    </p>}
    <div className="tool-option-details tool-page-selection">
      <label htmlFor="pdf-image-pages">Pages</label>
      <select id="pdf-image-pages" value={value.pageSelection}
        onChange={(event) => update({ pageSelection: event.target.value as PdfPageSelection })}>
        <option value="all">All pages</option>
        <option value="custom">Only these pages</option>
      </select>
      {value.pageSelection === 'custom' && <>
        <label htmlFor="pdf-image-ranges">Pages or ranges</label>
        <input id="pdf-image-ranges" type="text" inputMode="numeric" value={value.ranges}
          placeholder="1-3, 5, 8-10" onChange={(event) => update({ ranges: event.target.value })} />
        <p className="tool-hint">Use commas between pages or ranges.</p>
      </>}
    </div>
  </fieldset>;
}
