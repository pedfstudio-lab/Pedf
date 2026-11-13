import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PdfPasswordError } from '@/lib/pdf/passwordError';
import { unlockPdfFile } from '@/lib/pdf/protection';
import { siteHref } from '@/lib/site/config';
import { navigate } from '@/lib/site/navigate';
import { isPdf } from '@/lib/site/pdfFile';
import { setPendingFiles, takePendingFiles } from '@/lib/site/pendingFiles';
import { downloadBytes, zipOutputs } from '@/lib/tools/download';
import { validateFiles } from '@/lib/tools/files';
import { formatBytes, friendlyError } from '@/lib/tools/pdfIo';
import type { ToolDefinition, ToolOptions, ToolOutput } from '@/lib/tools/types';
import { UnlockPdfError } from '@/lib/unlockPdf/protocol';
import { DOCUMENT_PASSWORD_FIELD } from '@/lib/util/documentPasswordField';
import { ToolDropZone } from './ToolDropZone';
import { ToolFilePreview } from './ToolFilePreview';
import { useToolMetadata } from './useToolMetadata';

/** `locked`: the PDF needs its password before the tool can use it. `attempt` resets the field after a wrong try. */
interface InputFile { id: number; file: File; locked?: { error?: string; busy?: boolean; attempt: number } }

/** Resolves to the file the tool should use (unlocked if it was protected), or null while it still needs a password. */
type FileCheck = Promise<File | null>;

function LockedFileForm({ fileName, error, busy, onUnlock }: { fileName: string; error?: string; busy?: boolean; onUnlock(password: string): void }) {
  const [password, setPassword] = useState('');
  const unlock = () => { if (password && !busy) onUnlock(password); };
  return <div className="tool-file-password">
    <label className="lock-field"><span><span aria-hidden="true">🔒 </span>Password for this PDF</span>
      <input {...DOCUMENT_PASSWORD_FIELD} type="password" value={password}
        aria-label={`Password for ${fileName}`} aria-invalid={Boolean(error)} disabled={busy} autoFocus={Boolean(error)}
        onKeyDown={(event) => { if (event.key === 'Enter') unlock(); }}
        onChange={(event) => setPassword(event.target.value)} />
    </label>
    <button className="tool-secondary" type="button" disabled={busy || !password} onClick={unlock}>{busy ? 'Unlocking…' : 'Unlock'}</button>
    {error && <p className="tool-file-error" role="alert">{error}</p>}
  </div>;
}

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
  const checks = useRef(new Map<number, FileCheck>());
  const running = status === 'running';
  const minimumInputs = tool.minInputs ?? 1;
  const inputFiles = useMemo(() => files.map(({ file }) => file), [files]);
  const lockedCount = files.filter((entry) => entry.locked).length;
  const canRunReason = tool.canRun?.(options, inputFiles);
  const runDisabled = files.length < minimumInputs || !!canRunReason || lockedCount > 0;
  const Options = tool.Options;
  useToolMetadata(tool.title, tool.description);

  /**
   * Locked and restricted PDFs are unlocked on the device as soon as they're added, so every
   * tool gets an ordinary file. A locked one waits for its password in its file card.
   */
  const checkFile = useCallback((id: number, file: File, password?: string): FileCheck => {
    const markLocked = (error?: string) => setFiles((current) => current.map((entry) => entry.id === id
      ? { ...entry, locked: { error, attempt: (entry.locked?.attempt ?? 0) + (error ? 1 : 0) } } : entry));
    const check = unlockPdfFile(file, password).then(({ file: ready, protection }) => {
      if (protection !== 'none' || password) {
        setFiles((current) => current.map((entry) => entry.id === id ? { id, file: ready } : entry));
      }
      return ready;
    }, (reason: unknown) => {
      if (reason instanceof PdfPasswordError) { markLocked(password ? reason.message : undefined); return null; }
      if (reason instanceof UnlockPdfError && reason.code === 'password') { markLocked(reason.message); return null; }
      if (reason instanceof UnlockPdfError) setError(reason.message);
      // Anything else (a damaged file, say): the tool itself explains it when it runs.
      return file;
    });
    checks.current.set(id, check);
    return check;
  }, []);

  const unlockWithPassword = useCallback((id: number, password: string) => {
    const entry = files.find((candidate) => candidate.id === id);
    if (!entry?.locked) return;
    setFiles((current) => current.map((candidate) => candidate.id === id && candidate.locked
      ? { ...candidate, locked: { ...candidate.locked, busy: true, error: undefined } } : candidate));
    void checkFile(id, entry.file, password);
  }, [checkFile, files]);

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
    for (const entry of added) if (isPdf(entry.file)) void checkFile(entry.id, entry.file);
  }, [checkFile, tool]);

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
    const entries = files;
    if (entries.length < minimumInputs || activeRun.current || lockedCount > 0
      || tool.canRun?.(options, entries.map(({ file }) => file))) return;
    const controller = new AbortController();
    const runOptions = structuredClone(options);
    if (tool.sensitiveOptions) setOptions(structuredClone(tool.defaultOptions));
    activeRun.current = controller;
    setError('');
    setWarnings([]);
    setOutputs([]);
    setStatus('running');
    setProgress({ value: 0, label: 'Preparing…' });
    try {
      // A file added a moment ago may still be being checked for a password.
      const ready = await Promise.all(entries.map(({ id, file }) => checks.current.get(id) ?? file));
      if (activeRun.current !== controller || controller.signal.aborted) return;
      const selectedFiles = ready.filter((file): file is File => file !== null);
      if (selectedFiles.length !== ready.length) {
        setError('Type the password for the locked PDF, then try again.');
        setStatus('idle');
        return;
      }
      const result = await tool.run(selectedFiles, runOptions, {
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
      if (tool.sensitiveOptions) Object.keys(runOptions).forEach(key => { delete runOptions[key]; });
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
    checks.current.clear();
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
          {files.map(({ file, id, locked }, index) => <li key={id} draggable={tool.multiple && !running && !locked}
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
            {locked ? <div className="tool-file-preview"><span className="tool-file-placeholder" aria-hidden="true">🔒</span><span>Locked</span></div>
              : <ToolFilePreview file={file} failureText={tool.previewFailureText} />}
            <div className="tool-file-name"><strong title={file.name}>{file.name}</strong><span>{formatBytes(file.size)}</span>
              {locked && <LockedFileForm key={locked.attempt} fileName={file.name} error={locked.error} busy={locked.busy}
                onUnlock={(password) => unlockWithPassword(id, password)} />}
            </div>
            <div className="tool-file-actions">
              {tool.multiple && <>
                <button type="button" aria-label={`Move ${file.name} up`} disabled={running || index === 0} onClick={() => reorder(index, index - 1)}>↑</button>
                <button type="button" aria-label={`Move ${file.name} down`} disabled={running || index === files.length - 1} onClick={() => reorder(index, index + 1)}>↓</button>
              </>}
              <button type="button" disabled={running} aria-label={`Remove ${file.name}`} onClick={() => {
                checks.current.delete(id);
                setFiles((current) => current.filter((entry) => entry.id !== id));
              }}>Remove</button>
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
        {lockedCount > 0 && <p className="tool-hint">{lockedCount === 1 ? 'Type the password for the locked PDF to continue. It stays on this device.'
          : `Type the passwords for the ${lockedCount} locked PDFs to continue. They stay on this device.`}</p>}
        {canRunReason && lockedCount === 0 && <p className="tool-hint">{canRunReason}</p>}
        {status === 'cancelled' && <p role="status">Cancelled. Your original files are unchanged.</p>}
      </div>}
    </>}
    {status === 'done' && <section className="tool-results" aria-label="Results">
      <h2>Your {outputs.length === 1 ? 'file is' : 'files are'} ready</h2>
      <ul>{outputs.map((output, index) => <li key={index}>
        <div className="tool-file-name"><strong>{output.name}</strong><span>{formatBytes(output.bytes.byteLength)}</span>
          {output.note && <p className={`tool-result-note tool-result-note-${output.note.tone}`} role="status">{output.note.text}</p>}
        </div>
        <div className="tool-result-actions">
          <button className="site-button" type="button" onClick={() => download(() => downloadBytes(output.name, output.bytes, output.mime))}>Download</button>
          {output.mime === 'application/pdf' && output.canOpenInEditor !== false && <button className="tool-secondary" type="button" onClick={() => {
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
