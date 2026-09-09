import type { ToolOptionsProps } from '@/lib/tools/types';
import type { SplitOptionsValue } from '@/lib/tools/splitOptions';

export function SplitOptions({ options, onChange, disabled }: ToolOptionsProps) {
  const value: SplitOptionsValue = {
    mode: options.mode === 'every-page' || options.mode === 'every-n' ? options.mode : 'custom',
    ranges: typeof options.ranges === 'string' ? options.ranges : '',
    everyN: typeof options.everyN === 'number' ? options.everyN : 2,
    mergeRanges: options.mergeRanges === true,
  };
  const update = (next: Partial<SplitOptionsValue>) => onChange({ ...value, ...next });

  return <fieldset className="tool-options" disabled={disabled}>
    <legend>How should we split it?</legend>
    <label className="tool-option-choice">
      <input type="radio" name="split-mode" value="custom" checked={value.mode === 'custom'}
        onChange={() => update({ mode: 'custom' })} />
      <span><strong>Custom ranges</strong><small>Create one PDF for each range you enter.</small></span>
    </label>
    {value.mode === 'custom' && <div className="tool-option-details">
      <label htmlFor="split-ranges">Pages or ranges</label>
      <input id="split-ranges" type="text" inputMode="numeric" value={value.ranges}
        placeholder="1-3, 5, 8-10" onChange={(event) => update({ ranges: event.target.value })} />
      <p className="tool-hint">Separate ranges with commas. Each range becomes its own PDF.</p>
      <label className="tool-checkbox">
        <input type="checkbox" checked={value.mergeRanges}
          onChange={(event) => update({ mergeRanges: event.target.checked })} />
        Merge selected ranges into one PDF
      </label>
    </div>}
    <label className="tool-option-choice">
      <input type="radio" name="split-mode" value="every-page" checked={value.mode === 'every-page'}
        onChange={() => update({ mode: 'every-page' })} />
      <span><strong>Every page</strong><small>Create a separate PDF for every page.</small></span>
    </label>
    <label className="tool-option-choice">
      <input type="radio" name="split-mode" value="every-n" checked={value.mode === 'every-n'}
        onChange={() => update({ mode: 'every-n' })} />
      <span><strong>Every N pages</strong><small>Split the PDF into equal-sized groups.</small></span>
    </label>
    {value.mode === 'every-n' && <div className="tool-option-details tool-option-number">
      <label htmlFor="split-every-n">Pages per PDF</label>
      <input id="split-every-n" type="number" min="1" step="1" value={value.everyN}
        onChange={(event) => update({ everyN: Number(event.target.value) })} />
    </div>}
  </fieldset>;
}
