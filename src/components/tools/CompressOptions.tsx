import { useEffect, useRef, useState } from 'react';
import { analyzeFile, type CompressAnalysis } from '@/lib/compress/analyze';
import { estimateAllLevels, estimateFileLevels } from '@/lib/compress/estimate';
import { LEVELS, LEVEL_LADDER, type CompressLevel } from '@/lib/compress/levels';
import { fileKey } from '@/lib/tools/organizePlan';
import { formatBytes } from '@/lib/tools/pdfIo';
import {
  compressProblem,
  limitBytes,
  parseCompressOptions,
  type CompressOptionsValue,
} from '@/lib/tools/compressOptions';
import type { ToolOptionsProps } from '@/lib/tools/types';

type Estimates = Readonly<Record<CompressLevel, number>>;
const PUBLIC_LEVELS = ['light', 'medium', 'strong', 'smallest'] as const;

const PRESET_LIMITS = [
  { label: '200 KB', value: 200, unit: 'KB' as const },
  { label: '500 KB', value: 500, unit: 'KB' as const },
  { label: '1 MB', value: 1, unit: 'MB' as const },
  { label: '2 MB', value: 2, unit: 'MB' as const },
];

function samePreset(value: CompressOptionsValue): boolean {
  return PRESET_LIMITS.some((preset) => preset.value === value.limitValue && preset.unit === value.limitUnit);
}

function analysisText(analysis: CompressAnalysis): string {
  if (analysis.photoCount < 1 || analysis.bytesInShrinkableImages < analysis.fileSize * 0.15) {
    return 'This file is mostly text and fonts, so it may not get much smaller.';
  }
  const photos = `${analysis.photoCount} ${analysis.photoCount === 1 ? 'photo takes' : 'photos take'}`;
  return `${photos} ${formatBytes(analysis.bytesInShrinkableImages)} of this ${formatBytes(analysis.fileSize)} file.`;
}

function estimateText(estimate: number, fileSize: number): string {
  return estimate >= fileSize * 0.95 ? 'No change' : `about ${formatBytes(estimate)}`;
}

function findingBytes(bytes: number): string {
  if (bytes >= 100_000 && bytes < 1024 ** 2) return `${Number((bytes / 1024 ** 2).toFixed(1))} MB`;
  return formatBytes(bytes);
}

function unusedFinding(analysis: CompressAnalysis): string {
  const plural = analysis.unusedPhotoCount !== 1;
  return `${analysis.unusedPhotoCount} ${plural ? 'photos' : 'photo'} (${findingBytes(analysis.unusedPhotoBytes)}) ${plural ? 'are' : 'is'} not shown on any page. We remove ${plural ? 'them' : 'it'}.`;
}

function duplicateFinding(analysis: CompressAnalysis): string {
  const plural = analysis.duplicateCount !== 1;
  return `${analysis.duplicateCount} ${plural ? 'photos are' : 'photo is'} stored more than once. We store ${plural ? 'them' : 'it'} once.`;
}

function suggestedLevel(estimates: Estimates | undefined, value: CompressOptionsValue): CompressLevel | undefined {
  if (!estimates || value.level !== 'fit' || !Number.isFinite(value.limitValue)) return undefined;
  const limit = limitBytes(value);
  return LEVEL_LADDER.find((level) => estimates[level] <= limit * 0.9) ?? 'smallest';
}

export function CompressOptions({ options, onChange, inputs, disabled }: ToolOptionsProps) {
  const value = parseCompressOptions(options);
  const currentOptions = useRef(options);
  currentOptions.current = options;
  const file = inputs[0];
  const [checking, setChecking] = useState(false);
  const [analysis, setAnalysis] = useState<CompressAnalysis>();
  const [estimates, setEstimates] = useState<Estimates>();
  const [customLimit, setCustomLimit] = useState(() => !samePreset(value));

  useEffect(() => {
    if (!file) {
      setChecking(false);
      setAnalysis(undefined);
      setEstimates(undefined);
      return;
    }
    const controller = new AbortController();
    setChecking(true);
    setAnalysis(undefined);
    setEstimates(undefined);
    onChange({
      ...parseCompressOptions(currentOptions.current),
      analysisFileKey: undefined,
      signed: undefined,
      acceptSignatureLoss: false,
    });
    void analyzeFile(file, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;
      setChecking(false);
      setAnalysis(result);
      onChange({
        ...parseCompressOptions(currentOptions.current),
        analysisFileKey: fileKey(file),
        signed: result.signed,
        acceptSignatureLoss: false,
      });
      try {
        const measured = await estimateFileLevels(file, result, controller.signal);
        if (!controller.signal.aborted) setEstimates(measured);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setEstimates(estimateAllLevels(result));
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      setChecking(false);
      onChange({
        ...parseCompressOptions(currentOptions.current),
        analysisFileKey: fileKey(file),
        signed: false,
        acceptSignatureLoss: false,
      });
    });
    return () => controller.abort();
  }, [file, onChange]);

  const checkedAnalysis = file && value.analysisFileKey === fileKey(file) ? analysis : undefined;
  const recommendation = suggestedLevel(estimates, value);
  const reason = compressProblem(value, inputs);

  function update(next: Partial<CompressOptionsValue>) {
    onChange({ ...value, ...next });
  }

  return <fieldset className="tool-options compress-options">
    <legend>Compression</legend>
    {checking && <div className="compress-analysis" role="status">Checking the file…</div>}
    {!checking && checkedAnalysis && <div className="compress-analysis compress-analysis-ready" role="status">
      <strong>{analysisText(checkedAnalysis)}</strong>
      <span>Text, fonts, links, forms and annotations stay as they are.</span>
      {(checkedAnalysis.trailingBytes >= 100_000 || checkedAnalysis.unusedPhotoBytes >= 100_000
        || checkedAnalysis.duplicateBytes >= 100_000) && <ul className="compress-findings">
        {checkedAnalysis.trailingBytes >= 100_000 && <li>{formatBytes(checkedAnalysis.trailingBytes)} of this file is empty padding left by another tool. We remove it.</li>}
        {checkedAnalysis.unusedPhotoBytes >= 100_000 && <li>{unusedFinding(checkedAnalysis)}</li>}
        {checkedAnalysis.duplicateBytes >= 100_000 && <li>{duplicateFinding(checkedAnalysis)}</li>}
      </ul>}
    </div>}

    <div className="compress-levels" role="radiogroup" aria-label="Compression level">
      {PUBLIC_LEVELS.map((level) => <label className="compress-level-card" key={level}>
        <input type="radio" name="compress-level" value={level} checked={value.level === level}
          disabled={disabled} onChange={() => update({ level })} />
        <span className="compress-level-copy">
          <strong>{LEVELS[level].label}</strong>
          <small>{LEVELS[level].description}</small>
        </span>
        <span className="compress-estimate">{estimates && checkedAnalysis ? estimateText(estimates[level], checkedAnalysis.fileSize) : '…'}</span>
      </label>)}
      <label className="compress-level-card compress-fit-card">
        <input type="radio" name="compress-level" value="fit" checked={value.level === 'fit'}
          disabled={disabled} onChange={() => update({ level: 'fit' })} />
        <span className="compress-level-copy">
          <strong>Fit under a size</strong>
          <small>For upload portals and attachment limits</small>
        </span>
      </label>
    </div>

    {value.level === 'fit' && <div className="compress-fit-options">
      <div className="compress-limit-chips" aria-label="Size limit">
        {PRESET_LIMITS.map((preset) => <button key={preset.label} type="button"
          className={!customLimit && value.limitValue === preset.value && value.limitUnit === preset.unit ? 'is-selected' : ''}
          disabled={disabled} onClick={() => {
            setCustomLimit(false);
            update({ limitValue: preset.value, limitUnit: preset.unit });
          }}>{preset.label}</button>)}
        <button type="button" className={customLimit ? 'is-selected' : ''} disabled={disabled}
          onClick={() => setCustomLimit(true)}>Custom</button>
      </div>
      {customLimit && <div className="compress-custom-limit">
        <label htmlFor="compress-limit">Custom size limit</label>
        <input id="compress-limit" type="number" min="0" step="any" inputMode="decimal" value={Number.isNaN(value.limitValue) ? '' : value.limitValue}
          disabled={disabled} onChange={(event) => update({ limitValue: event.target.value === '' ? Number.NaN : event.target.valueAsNumber })} />
        <label className="sr-only" htmlFor="compress-limit-unit">Size unit</label>
        <select id="compress-limit-unit" value={value.limitUnit} disabled={disabled}
          onChange={(event) => update({ limitUnit: event.target.value === 'MB' ? 'MB' : 'KB' })}>
          <option value="KB">KB</option><option value="MB">MB</option>
        </select>
      </div>}
      {reason === 'Enter a size limit of at least 20 KB.' && <p className="compress-limit-error" role="alert">{reason}</p>}
      {recommendation && <p className="compress-recommendation"><strong>{LEVELS[recommendation].label}</strong> is the gentlest level expected to fit.</p>}
    </div>}

    {!checking && checkedAnalysis?.signed && <div className="repair-status repair-status-warn" role="status">
      <p><strong>This file is digitally signed. Compressing it makes the signature invalid.</strong></p>
      <label className="tool-checkbox repair-confirm"><input type="checkbox" checked={value.acceptSignatureLoss}
        disabled={disabled} onChange={(event) => update({ acceptSignatureLoss: event.target.checked })} />
        <span>I understand</span>
      </label>
    </div>}
  </fieldset>;
}
