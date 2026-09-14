import { useEffect, useReducer, useState } from 'react';
import type { ProjectMetadata, ProjectStore } from './projectStore';

export type SavedProjectsStatus = 'loading' | 'ok' | 'unavailable';

export interface SavedProjectsValue {
  readonly status: SavedProjectsStatus;
  readonly projects: ProjectMetadata[];
}

/** A live view of the projects saved by one store in this tab. */
export function useSavedProjects(store: ProjectStore): SavedProjectsValue {
  const [value, setValue] = useState<SavedProjectsValue>({
    status: 'loading',
    projects: [],
  });
  const [, refreshSavedTime] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    let cancelled = false;
    let requestNumber = 0;
    const refresh = async () => {
      const request = ++requestNumber;
      const result = await store.list();
      if (cancelled || request !== requestNumber) return;
      if (result.status === 'ok') {
        setValue({ status: 'ok', projects: [...result.value] });
      } else {
        setValue({ status: 'unavailable', projects: [] });
      }
    };

    const unsubscribe = store.subscribe(() => void refresh());
    void refresh();
    const timer = window.setInterval(() => refreshSavedTime(), 30_000);
    return () => {
      cancelled = true;
      requestNumber += 1;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [store]);

  return value;
}
