import type { ToolOptionsProps } from '@/lib/tools/types';
import {
  IMAGES_PER_PAGE_CHOICES,
  imagesPerPageOf,
  type ImagePageMargin,
  type ImagePageOrientation,
  type ImagePageSize,
  type JpgToPdfOptionsValue,
} from '@/lib/tools/jpgToPdfOptions';

export function JpgToPdfOptions({ options, onChange, disabled }: ToolOptionsProps) {
  const value: JpgToPdfOptionsValue = {
    pageSize: options.pageSize === 'a4' || options.pageSize === 'letter' ? options.pageSize : 'fit',
    orientation: options.orientation === 'portrait' || options.orientation === 'landscape' ? options.orientation : 'auto',
    margin: options.margin === 'small' || options.margin === 'big' ? options.margin : 'none',
    imagesPerPage: imagesPerPageOf(options.imagesPerPage),
  };
  const update = (next: Partial<JpgToPdfOptionsValue>) => onChange({ ...value, ...next });
  const grid = value.imagesPerPage > 1;

  return <fieldset className="tool-options" disabled={disabled}>
    <legend>PDF layout</legend>
    <div className="tool-select-grid">
      <label className="tool-select-field">Page size
        <select value={value.pageSize} onChange={(event) => update({ pageSize: event.target.value as ImagePageSize })}>
          <option value="fit">{grid ? 'A4 (fit to image needs 1 per page)' : 'Fit to image'}</option>
          <option value="a4">A4</option>
          <option value="letter">Letter</option>
        </select>
      </label>
      <label className="tool-select-field">Orientation
        <select value={value.orientation} onChange={(event) => update({ orientation: event.target.value as ImagePageOrientation })}>
          <option value="auto">Auto</option>
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </label>
      <label className="tool-select-field">Margin
        <select value={value.margin} onChange={(event) => update({ margin: event.target.value as ImagePageMargin })}>
          <option value="none">None</option>
          <option value="small">Small</option>
          <option value="big">Big</option>
        </select>
      </label>
      <div className="tool-select-field">
        <label htmlFor="images-per-page">Images per page</label>
        <select
          id="images-per-page"
          value={String(value.imagesPerPage)}
          aria-describedby="images-per-page-hint"
          onChange={(event) => update({ imagesPerPage: imagesPerPageOf(Number(event.target.value)) })}
        >
          {IMAGES_PER_PAGE_CHOICES.map((count) => <option key={count} value={count}>{count}</option>)}
        </select>
        <small id="images-per-page-hint">
          {grid ? 'Photos are arranged in a grid on each page.' : 'Choose 2 or 4 to put several photos on one page.'}
        </small>
      </div>
    </div>
  </fieldset>;
}
