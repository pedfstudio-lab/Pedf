import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { siteHref } from '@/lib/site/config';
import { navigate } from '@/lib/site/navigate';
import { setPendingFiles, takePendingFiles } from '@/lib/site/pendingFiles';
import { downloadBytes, zipOutputs } from '@/lib/tools/download';
import { validateFiles } from '@/lib/tools/files';
import { formatBytes, friendlyError } from '@/lib/tools/pdfIo';
import type { ToolDefinition, ToolOptions, ToolOutput } from '@/lib/tools/types';
import { ToolDropZone } from './ToolDropZone';
import { ToolFilePreview } from './ToolFilePreview';
import { useToolMetadata } from './useToolMetadata';

interface InputFile { id: number; file: File }

export function ToolPage({ tool }: { tool: ToolDefinition }) {
  const [files, setFiles] = useState<InputFile[]>([]);
  const [options, setOptions] = useState<ToolOptions>(() => structuredClone(tool.defaultOptions));
  const [outputs, setOutputs] = useState<ToolOutput[]>([]);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'cancelled'>('idle');
  const [progress, setProgress] = useState({ value: 0, label: 'Preparing…' });
  const nextId = useRef(0);
  const pendingChecked = useRef(false);
  const activeRun = useRef<AbortController | null>(null);
  const dragged = useRef<number | null>(null);
  const running = status === 'running';
  const minimumInputs = tool.minInputs ?? 1;
  const inputFiles = useMemo(() => files.map(({ file }) => file), [files]);
  const canRunReason = tool.canRun?.(options, inputFiles);
  const runDisabled = files.length < minimumInputs || !!canRunReason;
  const Options = tool.Options;
  useToolMetadata(tool.title, tool.description);

  const addFiles = useCallback((incoming: File[]) => {
    if (!incoming.length || activeRun.current) return;
    const problem = validateFiles(incoming, tool);
    if (problem) { setError(problem); return; }
    const added = incoming.map((file) => ({ file, id: nextId.current++ }));
    setFiles((current) => tool.multiple ? [...current, ...added] : added);
    setError('');
    setOutputs([]);
    setWarnings([]);
    setStatus('idle');
  }, [tool]);

  useEffect(() => {
    if (pendingChecked.current) return;
    pendingChecked.current = true;
    addFiles(takePendingFiles());
  }, [addFiles]);

  useEffect(() => () => {
    activeRun.current?.abort();
    activeRun.current = null;
  }, []);

  function reorder(from: number, to: number) {
    if (activeRun.current || from === to) return;
    setFiles((current) => {
      const updated = [...current];
      const [moved] = updated.splice(from, 1);
      if (moved) updated.splice(to, 0, moved);
      return updated;
    });
  }

  async function run() {
    const selectedFiles = files.map(({ file }) => file);
    if (files.length < minimumInputs || activeRun.current || tool.canRun?.(options, selectedFiles)) return;
    const controller = new AbortController();
    activeRun.current = controller;
    setError('');
    setWarnings([]);
    setOutputs([]);
    setStatus('running');
    setProgress({ value: 0, label: 'Preparing…' });
    try {
      const result = await tool.run(selectedFiles, structuredClone(options), {
        signal: controller.signal,
        onProgress(done, total, label) {
          if (activeRun.current !== controller || controller.signal.aborted) return;
          const value = total > 0 ? done / total * 100 : 0;
          setProgress({ value: Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0, label });
        },
        onWarning(message) {
          if (activeRun.current !== controller || controller.signal.aborted) return;
          setWarnings((current) => current.includes(message) ? current : [...current, message]);
        },
      });
      if (activeRun.current !== controller || controller.signal.aborted) return;
      if (!result.length) { setError('The tool did not produce any files. Please try again.'); setStatus('idle'); return; }
      setOutputs(result);
      setStatus('done');
    } catch (reason) {
      if (activeRun.current === controller && !controller.signal.aborted) {
        setError(friendlyError(reason));
        setStatus('idle');
      }
    } finally {
      if (activeRun.current === controller) activeRun.current = null;
    }
  }

  function cancel() {
    activeRun.current?.abort();
    activeRun.current = null;
    setStatus('cancelled');
    setWarnings([]);
  }

  function startOver() {
    setFiles([]);
    setOutputs([]);
    setOptions(structuredClone(tool.defaultOptions));
    setError('');
    setWarnings([]);
    setStatus('idle');
  }

  function download(action: () => void) {
    try { action(); } catch { setError('The download could not be prepared. Please try again.'); }
  }

  return <main className="site-shell tool-main">
    <a className="tool-back" href={siteHref('/tools')}>← All tools</a>
    <header className="tool-heading"><h1>{tool.title}</h1><p>{tool.description}</p></header>
    <p className="tool-local-note">Processed in your browser. Your files are not uploaded.</p>
    {error && <div className="tool-error" role="alert">{error}</div>}
    {warnings.length > 0 && <div className="tool-warning" role="status"><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
    {status !== 'done' && <>
      <ToolDropZone tool={tool} onFiles={addFiles} disabled={running} />
      {files.length > 0 && <section className="tool-section" aria-label="Selected files">
        <h2>{files.length} {files.length === 1 ? 'file' : 'files'} selected</h2>
        {tool.multiple && files.length > 1 && <p className="tool-hint">Drag files to change their order, or use the arrow buttons.</p>}
        <ol className="tool-files">
          {files.map(({ file, id }, index) => <li key={id} draggable={tool.multiple && !running}
            onDragStart={(event) => {
              dragged.current = id;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', String(id));
            }}
            onDragEnd={() => { dragged.current = null; }}
            onDragOver={(event) => { if (dragged.current !== null && !running) event.preventDefault(); }}
            onDrop={(event) => {
              if (dragged.current === null || running) return;
              event.preventDefault();
              const from = files.findIndex((entry) => entry.id === dragged.current);
              if (from >= 0) reorder(from, index);
              dragged.current = null;
            }}>
            <ToolFilePreview file={file} />
            <div className="tool-file-name"><strong title={file.name}>{file.name}</strong><span>{formatBytes(file.size)}</span></div>
            <div className="tool-file-actions">
              {tool.multiple && <>
                <button type="button" aria-label={`Move ${file.name} up`} disabled={running || index === 0} onClick={() => reorder(index, index - 1)}>↑</button>
                <button type="button" aria-label={`Move ${file.name} down`} disabled={running || index === files.length - 1} onClick={() => reorder(index, index + 1)}>↓</button>
              </>}
              <button type="button" disabled={running} aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((entry) => entry.id !== id))}>Remove</button>
            </div>
          </li>)}
        </ol>
      </section>}
      {Options && <section className="tool-section" aria-label="Tool options"><Options
        options={options} onChange={setOptions} inputs={inputFiles} disabled={running} /></section>}
      {running ? <section className="tool-progress" aria-label="Processing">
        <p role="status">{progress.label}</p>
        <progress value={progress.value} max={100} aria-label="Tool progress" />
        <button className="tool-secondary" type="button" onClick={cancel}>Cancel</button>
      </section> : <div className="tool-run">
        <button className="site-button" type="button" disabled={runDisabled} aria-disabled={runDisabled}
          title={canRunReason} onClick={() => void run()}>{tool.title}</button>
        {minimumInputs > 1 && files.length < minimumInputs && <p className="tool-hint">Choose at least {minimumInputs} files to continue.</p>}
        {canRunReason && <p className="tool-hint">{canRunReason}</p>}
        {status === 'cancelled' && <p role="status">Cancelled. Your original files are unchanged.</p>}
      </div>}
    </>}
    {status === 'done' && <section className="tool-results" aria-label="Results">
      <h2>Your {outputs.length === 1 ? 'file is' : 'files are'} ready</h2>
      <ul>{outputs.map((output, index) => <li key={index}>
        <div className="tool-file-name"><strong>{output.name}</strong><span>{formatBytes(output.bytes.byteLength)}</span></div>
        <div className="tool-result-actions">
          <button className="site-button" type="button" onClick={() => download(() => downloadBytes(output.name, output.bytes, output.mime))}>Download</button>
          {output.mime === 'application/pdf' && <button className="tool-secondary" type="button" onClick={() => {
            setPendingFiles([new File([output.bytes.slice().buffer], output.name, { type: 'application/pdf' })]);
            navigate('/app');
          }}>Open in editor</button>}
        </div>
      </li>)}</ul>
      <div className="tool-result-actions">
        {outputs.length > 1 && <button className="site-button" type="button" onClick={() => download(() => downloadBytes(`${tool.slug}-results.zip`, zipOutputs(outputs), 'application/zip'))}>Download all (.zip)</button>}
        <button className="tool-secondary" type="button" onClick={startOver}>Start over</button>
      </div>
    </section>}
  </main>;
}
