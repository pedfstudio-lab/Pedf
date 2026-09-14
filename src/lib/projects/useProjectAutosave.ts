import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryState } from '@/state/editsStore';
import type { ProjectStore } from './projectStore';
import { serializeProject } from './projectState';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'full' | 'unavailable';
/** 'no-changes' is reserved for a fresh file that has never needed a project. */
export type SaveOutcome = 'saved' | 'draft' | 'full' | 'unavailable' | 'no-project' | 'no-changes';

export interface ProjectAutosaveSnapshot {
  readonly history: HistoryState;
  readonly revision: number;
  readonly pageCount: number;
  readonly lastPage: number;
  readonly zoom: number;
  readonly changeCount: number;
}

export interface CreateProjectResult {
  readonly outcome: SaveOutcome;
  readonly projectId?: string;
}

interface UseProjectAutosaveOptions {
  readonly projectId?: string;
  readonly initialSavedAt?: number;
  readonly documentKey: object | string | null;
  readonly snapshot: ProjectAutosaveSnapshot;
  readonly store: ProjectStore;
  readonly hasChanges: boolean;
  createProject(): Promise<CreateProjectResult>;
  isDraftOpen(): boolean;
}

interface ProjectAutosaveValue {
  readonly status: SaveStatus;
  readonly savedAt?: number;
  saveNow(): Promise<SaveOutcome>;
}

function snapshotKey(snapshot: ProjectAutosaveSnapshot): string {
  return `${snapshot.revision}:${snapshot.lastPage}:${snapshot.zoom}`;
}

export function useProjectAutosave({
  projectId,
  initialSavedAt,
  documentKey,
  snapshot,
  store,
  hasChanges,
  createProject,
  isDraftOpen,
}: UseProjectAutosaveOptions): ProjectAutosaveValue {
  const [status, setStatus] = useState<SaveStatus>(projectId ? 'saved' : 'idle');
  const [savedAt, setSavedAt] = useState<number | undefined>(initialSavedAt);
  const snapshotRef = useRef(snapshot);
  const projectIdRef = useRef(projectId);
  const documentKeyRef = useRef(documentKey);
  const previousDocumentKey = useRef(documentKey);
  const hasChangesRef = useRef(hasChanges);
  const lastSavedKey = useRef<string>();
  const saveInFlight = useRef<{
    readonly documentKey: object | string | null;
    readonly promise: Promise<void>;
  }>();
  const createInFlight = useRef<{
    readonly documentKey: object | string | null;
    readonly key: string;
    readonly revision: number;
    readonly promise: Promise<CreateProjectResult>;
  }>();
  const createdProjectIdRef = useRef<string>();
  const createdSavedKey = useRef<string>();
  const lastCreateAttemptRevision = useRef<number>();
  const currentKey = snapshotKey(snapshot);

  if (previousDocumentKey.current !== documentKey) {
    previousDocumentKey.current = documentKey;
    createdProjectIdRef.current = undefined;
    createdSavedKey.current = undefined;
    lastSavedKey.current = undefined;
    lastCreateAttemptRevision.current = undefined;
  }
  snapshotRef.current = snapshot;
  projectIdRef.current = projectId;
  documentKeyRef.current = documentKey;
  hasChangesRef.current = hasChanges;

  useEffect(() => {
    if (projectId) {
      lastSavedKey.current = createdProjectIdRef.current === projectId && createdSavedKey.current
        ? createdSavedKey.current
        : snapshotKey(snapshotRef.current);
      setStatus('saved');
      setSavedAt(initialSavedAt);
    } else {
      if (!createdProjectIdRef.current) {
        lastSavedKey.current = undefined;
        setStatus('idle');
        setSavedAt(undefined);
      }
    }
    lastCreateAttemptRevision.current = undefined;
  }, [initialSavedAt, projectId]);

  useEffect(() => {
    setStatus(projectId ? 'saved' : 'idle');
    setSavedAt(projectId ? initialSavedAt : undefined);
  }, [documentKey, initialSavedAt, projectId]);

  useEffect(() => {
    if (projectId || createdProjectIdRef.current || hasChanges) return;
    lastCreateAttemptRevision.current = undefined;
    setStatus('idle');
    setSavedAt(undefined);
  }, [hasChanges, projectId]);

  const save = useCallback(async (): Promise<SaveOutcome | 'skipped'> => {
    const requestedDocumentKey = documentKeyRef.current;

    while (documentKeyRef.current === requestedDocumentKey) {
      const id = projectIdRef.current ?? createdProjectIdRef.current;
      const current = snapshotRef.current;
      const key = snapshotKey(current);

      if (!id) {
        const pendingCreate = createInFlight.current;
        if (pendingCreate) {
          if (pendingCreate.documentKey !== requestedDocumentKey && !hasChangesRef.current) {
            return 'no-changes';
          }
          const result = await pendingCreate.promise;
          if (createInFlight.current === pendingCreate) createInFlight.current = undefined;
          if (documentKeyRef.current !== requestedDocumentKey) return 'no-project';
          if (pendingCreate.documentKey !== requestedDocumentKey) continue;
          if (result.outcome === 'full' || result.outcome === 'unavailable') return result.outcome;
          if (result.outcome !== 'saved' || !createdProjectIdRef.current) return 'no-project';
          continue;
        }

        if (!hasChangesRef.current) return 'no-changes';
        if (isDraftOpen()) return 'draft';

        const requestDocumentKey = requestedDocumentKey;
        const request = {
          documentKey: requestDocumentKey,
          key,
          revision: current.revision,
          promise: (async (): Promise<CreateProjectResult> => {
            setStatus('saving');
            let result: CreateProjectResult;
            try {
              result = await createProject();
            } catch {
              result = { outcome: 'unavailable' };
            }
            if (documentKeyRef.current !== requestDocumentKey) return result;
            if (result.outcome === 'saved' && result.projectId) {
              createdProjectIdRef.current = result.projectId;
              createdSavedKey.current = key;
              lastSavedKey.current = key;
              setStatus('saved');
            } else if (result.outcome === 'full' || result.outcome === 'unavailable') {
              lastCreateAttemptRevision.current = current.revision;
              setStatus(result.outcome);
            } else {
              setStatus('idle');
            }
            return result;
          })(),
        };
        createInFlight.current = request;
        const result = await request.promise;
        if (createInFlight.current === request) createInFlight.current = undefined;
        if (documentKeyRef.current !== requestedDocumentKey) return 'no-project';
        if (result.outcome === 'full' || result.outcome === 'unavailable') return result.outcome;
        if (result.outcome !== 'saved' || !createdProjectIdRef.current) return 'no-project';
        continue;
      }

      if (key === lastSavedKey.current) return 'skipped';
      if (isDraftOpen()) return 'draft';
      const pendingSave = saveInFlight.current;
      if (pendingSave) {
        await pendingSave.promise;
        if (saveInFlight.current === pendingSave) saveInFlight.current = undefined;
        continue;
      }

      const requestDocumentKey = requestedDocumentKey;
      const request = (async (): Promise<SaveOutcome> => {
        setStatus('saving');
        const result = await store.saveState(
          id,
          serializeProject(current.history, current.lastPage, current.zoom),
          {
            pageCount: current.pageCount,
            lastPage: current.lastPage,
            zoom: current.zoom,
            changeCount: current.changeCount,
          },
        );
        if (documentKeyRef.current !== requestDocumentKey) return result.status === 'ok' ? 'saved' : result.status;
        if (result.status === 'ok') {
          lastSavedKey.current = key;
          setSavedAt(result.value.updatedAt);
          setStatus('saved');
          return 'saved';
        }
        setStatus(result.status);
        return result.status;
      })();
      const pending = { documentKey: requestDocumentKey, promise: request.then(() => undefined) };
      saveInFlight.current = pending;
      try {
        return await request;
      } finally {
        if (saveInFlight.current === pending) saveInFlight.current = undefined;
      }
    }

    return 'no-project';
  }, [createProject, isDraftOpen, store]);

  useEffect(() => {
    if (projectId || createdProjectIdRef.current) {
      if (currentKey === lastSavedKey.current) return;
    } else {
      if (
        !hasChanges
        || snapshot.revision === lastCreateAttemptRevision.current
      ) return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const attempt = async () => {
      const result = await save();
      if (!cancelled && result === 'draft') timer = window.setTimeout(() => void attempt(), 1000);
    };
    timer = window.setTimeout(() => void attempt(), 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentKey, hasChanges, projectId, save, snapshot.revision]);

  useEffect(() => {
    const flush = () => {
      const current = snapshotRef.current;
      const shouldSaveExisting = Boolean(projectIdRef.current ?? createdProjectIdRef.current)
        && snapshotKey(current) !== lastSavedKey.current;
      const shouldCreate = !projectIdRef.current
        && !createdProjectIdRef.current
        && hasChangesRef.current
        && current.revision !== lastCreateAttemptRevision.current;
      if ((shouldSaveExisting || shouldCreate) && !isDraftOpen()) void save();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flush);
    };
  }, [isDraftOpen, save]);

  const saveNow = useCallback(async (): Promise<SaveOutcome> => {
    const outcome = await save();
    return outcome === 'skipped' ? 'saved' : outcome;
  }, [save]);

  return { status, savedAt, saveNow };
}
