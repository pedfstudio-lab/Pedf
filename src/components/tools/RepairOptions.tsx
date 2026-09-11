import { useEffect, useRef, useState } from 'react';
import { fileKey } from '@/lib/tools/organizePlan';
import { inspectPdf, type Inspection } from '@/lib/tools/repairInspect';
import { parseRepairOptions, repairProblem } from '@/lib/tools/repairOptions';
import type { ToolOptionsProps } from '@/lib/tools/types';

interface Progress { done: number; total: number }

export function RepairOptions({ options, onChange, inputs, disabled }: ToolOptionsProps) {
  const value = parseRepairOptions(options);
  const currentOptions = useRef(options);
  currentOptions.current = options;
  const file = inputs[0];
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<Progress>();

  useEffect(() => {
    if (!file) {
      setChecking(false);
      setProgress(undefined);
      return;
    }
    const controller = new AbortController();
    setChecking(true);
    setProgress(undefined);
    onChange({
      ...parseRepairOptions(currentOptions.current),
      inspection: undefined,
      repairAnyway: false,
      acceptSignatureLoss: false,
    });
    void file.arrayBuffer().then((buffer) => inspectPdf(
      new Uint8Array(buffer),
      (done, total) => { if (!controller.signal.aborted) setProgress({ done, total }); },
      controller.signal,
    )).then((inspection) => {
      if (controller.signal.aborted) return;
      setChecking(false);
      onChange({
        ...parseRepairOptions(currentOptions.current),
        inspection: { ...inspection, fileKey: fileKey(file) },
        repairAnyway: false,
        acceptSignatureLoss: false,
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      setChecking(false);
      const inspection: Inspection = {
        kind: 'damaged', badPages: [], problems: ["the file's index is broken"], signed: false,
      };
      onChange({
        ...parseRepairOptions(currentOptions.current),
        inspection: { ...inspection, fileKey: fileKey(file) },
        repairAnyway: false,
        acceptSignatureLoss: false,
      });
    });
    return () => controller.abort();
  }, [file, onChange]);

  const inspection = value.inspection?.fileKey === (file ? fileKey(file) : '') ? value.inspection : undefined;
  const repairWillRun = inspection?.kind === 'damaged' || (inspection?.kind === 'healthy' && value.repairAnyway);
  const signed = repairWillRun && inspection && 'signed' in inspection && inspection.signed;
  const reason = file && inspection ? repairProblem(value, [file]) : undefined;

  return <fieldset className="tool-options">
    <legend>File check</legend>
    {checking && <div className="repair-status" role="status"><p>{progress && progress.total > 0
      ? `Checking your file… (page ${progress.done} of ${progress.total})`
      : 'Checking your file…'}</p></div>}
    {!checking && inspection?.kind === 'healthy' && <div className="repair-status repair-status-ok" role="status">
      <p><strong>This file looks healthy.</strong></p>
      <label className="tool-checkbox repair-confirm"><input type="checkbox" checked={value.repairAnyway} disabled={disabled}
        onChange={(event) => onChange({ ...value, repairAnyway: event.target.checked, acceptSignatureLoss: false })} />
        <span>Repair anyway — rewrites the file. Use this if another app still refuses it.</span>
      </label>
    </div>}
    {!checking && inspection?.kind === 'damaged' && <div className="repair-status repair-status-warn" role="status">
      <p><strong>This file is damaged:</strong></p>
      <ul>{inspection.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
      <p>Repair will rebuild it.</p>
    </div>}
    {!checking && (inspection?.kind === 'locked' || inspection?.kind === 'not-pdf') && <div
      className="repair-status repair-status-danger" role="status"><p>{reason}</p></div>}
    {!checking && signed && <div className="repair-status repair-status-warn" role="status">
      <p><strong>This file has a digital signature. Any repair makes the signature invalid.</strong></p>
      <label className="tool-checkbox repair-confirm"><input type="checkbox" checked={value.acceptSignatureLoss}
        disabled={disabled} onChange={(event) => onChange({ ...value, acceptSignatureLoss: event.target.checked })} />
        <span>I understand</span>
      </label>
    </div>}
  </fieldset>;
}
