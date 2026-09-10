import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createEntries,
  duplicatePage,
  fileKey,
  insertBlankAfter,
  movePage,
  rememberPageCount,
  reconcilePlan,
  removePage,
  rotatePage,
  type OrganizeEntry,
  type OrganizeFileInfo,
  type OrganizePlan,
  type PageSizePt,
} from '@/lib/tools/organizePlan';
import { parseOrganizeOptions } from '@/lib/tools/organizeOptions';
import { previewPdfPages } from '@/lib/tools/preview';
import type { ToolOptionsProps } from '@/lib/tools/types';

interface FilePreviewRecord {
  file: File;
  pageCount: number;
  sizes: Array<PageSizePt | undefined>;
  thumbnails: Array<string | undefined>;
  controller: AbortController;
  failed: boolean;
  ready: Promise<void>;
}

function samePlan(left: OrganizePlan, right: OrganizePlan): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function shortName(name: string): string {
  const stem = name.replace(/\.pdf$/i, '');
  return stem.length <= 20 ? stem : `${stem.slice(0, 18)}…`;
}

function displayedSize(entry: OrganizeEntry, record: FilePreviewRecord | undefined): PageSizePt | undefined {
  if (entry.kind === 'blank') return { w: entry.widthPt, h: entry.heightPt };
  const size = record?.sizes[entry.pageIndex];
  if (!size) return undefined;
  return entry.turns % 2 === 0 ? size : { w: size.h, h: size.w };
}

function blankPreviewStyle(entry: Extract<OrganizeEntry, { kind: 'blank' }>) {
  const scale = 116 / Math.max(entry.widthPt, entry.heightPt);
  return { width: Math.max(24, entry.widthPt * scale), height: Math.max(24, entry.heightPt * scale) };
}

export function OrganizeOptions({ options, onChange, inputs, disabled }: ToolOptionsProps) {
  const value = parseOrganizeOptions(options);
  const cache = useRef(new Map<string, FilePreviewRecord>());
  const planRef = useRef<OrganizePlan>(value.plan);
  const inputRef = useRef(inputs);
  const nextId = useRef(0);
  const draggedId = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [, refresh] = useState(0);
  planRef.current = value.plan;
  inputRef.current = inputs;

  const newId = useCallback(() => `organize-${nextId.current++}`, []);
  const commit = useCallback((plan: OrganizePlan) => {
    planRef.current = plan;
    onChange({ plan: [...plan] });
  }, [onChange]);

  const knownFiles = useCallback((): OrganizeFileInfo[] => inputRef.current.flatMap((file) => {
    const key = fileKey(file);
    const record = cache.current.get(key);
    return record && record.pageCount > 0 ? [{ key, pageCount: record.pageCount }] : [];
  }), []);

  useEffect(() => {
    const activeKeys = new Set(inputs.map(fileKey));
    for (const [key, record] of cache.current) {
      if (!activeKeys.has(key)) {
        record.controller.abort();
        cache.current.delete(key);
      }
    }

    const reconciled = reconcilePlan(planRef.current, knownFiles(), newId);
    if (!samePlan(reconciled, planRef.current)) commit(reconciled);

    let preceding = Promise.resolve();
    for (const file of inputs) {
      const key = fileKey(file);
      const existing = cache.current.get(key);
      if (existing && !existing.controller.signal.aborted) {
        preceding = existing.ready;
        continue;
      }
      if (existing) cache.current.delete(key);
      const controller = new AbortController();
      const record: FilePreviewRecord = {
        file, pageCount: 0, sizes: [], thumbnails: [], controller, failed: false, ready: Promise.resolve(),
      };
      cache.current.set(key, record);
      // Grow the plan to `count` pages for this file: all at once when the page count arrives, or
      // page by page as a fallback. Running the tool never depends on thumbnails being ready.
      const growTo = (count: number) => {
        if (controller.signal.aborted || cache.current.get(key) !== record) return;
        const previousCount = record.pageCount;
        if (count <= previousCount) return;
        record.pageCount = count;
        rememberPageCount(file, count);
        let plan = planRef.current;
        if (previousCount === 0) {
          plan = reconcilePlan(plan, knownFiles(), newId);
        } else {
          const additions = createEntries(key, count, newId).slice(previousCount);
          const missing = additions.filter((entry) => entry.kind === 'page'
            && !plan.some((candidate) => candidate.kind === 'page'
              && candidate.fileKey === key && candidate.pageIndex === entry.pageIndex));
          if (missing.length) plan = [...plan, ...missing];
        }
        if (!samePlan(plan, planRef.current)) commit(plan);
      };
      record.ready = preceding.then(async () => {
        controller.signal.throwIfAborted();
        await previewPdfPages(file, controller.signal, (pageIndex, thumbnail, sizePt) => {
          if (controller.signal.aborted || cache.current.get(key) !== record) return;
          growTo(pageIndex + 1);
          record.sizes[pageIndex] = sizePt;
          record.thumbnails[pageIndex] = thumbnail;
          refresh((version) => version + 1);
        }, 140, (count) => {
          growTo(count);
          refresh((version) => version + 1);
        });
      }).catch(() => {
        if (controller.signal.aborted || cache.current.get(key) !== record) return;
        record.failed = true;
        refresh((version) => version + 1);
      });
      preceding = record.ready;
    }
  }, [commit, inputs, knownFiles, newId]);

  useEffect(() => () => {
    for (const record of cache.current.values()) record.controller.abort();
    cache.current.clear();
  }, []);

  const filesByKey = useMemo(() => new Map(inputs.map((file) => [fileKey(file), file])), [inputs]);

  const update = (operation: (plan: OrganizePlan) => OrganizePlan) => commit(operation(planRef.current));
  const reset = () => commit(reconcilePlan([], knownFiles(), newId));

  return <fieldset className="tool-options" disabled={disabled}>
    <legend>Pages</legend>
    <div className="organize-toolbar">
      <strong>{value.plan.length} {value.plan.length === 1 ? 'page' : 'pages'}</strong>
      <span className="tool-hint">Drop another PDF above to add its pages at the end.</span>
      <button type="button" className="tool-secondary" onClick={reset}>Reset</button>
    </div>
    <ol className="organize-grid">
      {value.plan.map((entry, position) => {
        const pageNumber = position + 1;
        const record = entry.kind === 'page' ? cache.current.get(entry.fileKey) : undefined;
        const thumbnail = entry.kind === 'page' ? record?.thumbnails[entry.pageIndex] : undefined;
        const size = displayedSize(entry, record);
        const sourceFile = entry.kind === 'page' ? filesByKey.get(entry.fileKey) : undefined;
        const className = ['organize-card', dragging === entry.id && 'is-dragging', dropTarget === entry.id && 'is-drop-target']
          .filter(Boolean).join(' ');
        return <li key={entry.id} className={className} draggable={!disabled}
          onDragStart={(event) => {
            draggedId.current = entry.id;
            setDragging(entry.id);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', entry.id);
          }}
          onDragEnd={() => {
            draggedId.current = null;
            setDragging(null);
            setDropTarget(null);
          }}
          onDragOver={(event) => {
            if (!disabled && draggedId.current && draggedId.current !== entry.id) {
              event.preventDefault();
              setDropTarget(entry.id);
            }
          }}
          onDragLeave={() => { if (dropTarget === entry.id) setDropTarget(null); }}
          onDrop={(event) => {
            event.preventDefault();
            const from = planRef.current.findIndex((candidate) => candidate.id === draggedId.current);
            const to = planRef.current.findIndex((candidate) => candidate.id === entry.id);
            if (from >= 0 && to >= 0) update((plan) => movePage(plan, from, to));
            draggedId.current = null;
            setDragging(null);
            setDropTarget(null);
          }}>
          <div className="organize-thumbnail">
            {entry.kind === 'blank' ? <span className="organize-blank" style={blankPreviewStyle(entry)}>Blank</span>
              : thumbnail ? <img src={thumbnail} alt={`Page ${pageNumber} thumbnail`}
                style={{ transform: `rotate(${entry.turns * 90}deg)`, transition: 'transform 200ms' }} />
                : <span aria-label={`Loading page ${pageNumber}`}>{record?.failed ? 'Preview unavailable' : '…'}</span>}
          </div>
          <div className="organize-caption"><strong>Page {pageNumber}</strong>
            {inputs.length > 1 && sourceFile && <span title={sourceFile.name}>{shortName(sourceFile.name)}</span>}
          </div>
          <div className="organize-actions">
            <button type="button" aria-label={`Move page ${pageNumber} left`} disabled={position === 0}
              onClick={() => update((plan) => movePage(plan, position, position - 1))}>◀</button>
            <button type="button" aria-label={`Move page ${pageNumber} right`} disabled={position === value.plan.length - 1}
              onClick={() => update((plan) => movePage(plan, position, position + 1))}>▶</button>
            <button type="button" aria-label={`Rotate page ${pageNumber} left`}
              onClick={() => update((plan) => rotatePage(plan, position, 'left'))}>↺</button>
            <button type="button" aria-label={`Rotate page ${pageNumber} right`}
              onClick={() => update((plan) => rotatePage(plan, position, 'right'))}>↻</button>
            <button type="button" aria-label={`Duplicate page ${pageNumber}`}
              onClick={() => update((plan) => duplicatePage(plan, position, newId))}>⧉</button>
            <button type="button" aria-label={`Insert blank page after ${pageNumber}`} disabled={!size}
              onClick={() => { if (size) update((plan) => insertBlankAfter(plan, position, size, newId)); }}>＋</button>
            <button type="button" aria-label={`Delete page ${pageNumber}`}
              onClick={() => update((plan) => removePage(plan, position))}>×</button>
          </div>
        </li>;
      })}
    </ol>
    {!value.plan.length && inputs.length > 0 && <p className="tool-hint">Preparing pages…</p>}
  </fieldset>;
}
