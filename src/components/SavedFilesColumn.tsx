import { useState } from 'react';
import { projectStore as defaultProjectStore } from '@/lib/projects/projectStore';
import type { ProjectMetadata, ProjectStore } from '@/lib/projects/projectStore';
import { savedAgo } from '@/lib/projects/savedTime';
import { useSavedProjects } from '@/lib/projects/useSavedProjects';

interface SavedFilesColumnProps {
  readonly store?: ProjectStore;
  readonly currentProjectId?: string | null;
  readonly mode?: 'inline' | 'drawer';
  onOpen(id: string): boolean | void | Promise<boolean | void>;
  onHide(): void;
}

function changeLabel(project: ProjectMetadata): string {
  return `${project.changeCount} ${project.changeCount === 1 ? 'change' : 'changes'}`;
}

export function SavedFilesColumn({
  store = defaultProjectStore,
  currentProjectId,
  mode = 'inline',
  onOpen,
  onHide,
}: SavedFilesColumnProps) {
  const { status, projects } = useSavedProjects(store);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [actionsId, setActionsId] = useState<string | null>(null);

  const openProject = async (project: ProjectMetadata) => {
    if (openingId || project.id === currentProjectId) return;
    setActionsId(null);
    setOpeningId(project.id);
    try {
      await onOpen(project.id);
    } finally {
      setOpeningId(null);
    }
  };

  const deleteProject = async (project: ProjectMetadata) => {
    setActionsId(null);
    if (!window.confirm(`Delete the saved edits for ${project.fileName}? This can't be undone.`)) return;
    await store.delete(project.id);
  };

  return (
    <aside
      aria-label="Saved files"
      className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-200 bg-white text-neutral-900"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-3">
        <h2 className="text-sm font-semibold">Saved files ({projects.length})</h2>
        <button
          type="button"
          onClick={onHide}
          aria-label={mode === 'drawer' ? 'Close saved files' : 'Hide saved files'}
          className="rounded px-2 py-1 text-lg leading-none text-neutral-600 hover:bg-neutral-100"
        >
          {mode === 'drawer' ? '✕' : '◂'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {status === 'loading' && (
          <p className="px-2 py-3 text-sm text-neutral-500">Loading saved files…</p>
        )}
        {status === 'unavailable' && (
          <p className="px-2 py-3 text-sm text-neutral-600">Can&apos;t save on this device.</p>
        )}
        {status === 'ok' && projects.length === 0 && (
          <p className="px-2 py-3 text-sm leading-5 text-neutral-500">
            No saved files yet. Your changes save here automatically.
          </p>
        )}
        {status === 'ok' && projects.length > 0 && (
          <ul className="space-y-1">
            {projects.map((project) => {
              const current = project.id === currentProjectId;
              const opening = project.id === openingId;
              return (
                <li
                  key={project.id}
                  className={`relative flex items-stretch rounded-lg border ${current
                    ? 'border-blue-200 bg-blue-50'
                    : 'border-transparent hover:border-neutral-200 hover:bg-neutral-50'}`}
                >
                  <button
                    type="button"
                    title={project.fileName}
                    aria-current={current ? 'true' : undefined}
                    disabled={current || (openingId !== null && !opening)}
                    onClick={() => void openProject(project)}
                    className={`min-w-0 flex-1 px-2 py-2.5 text-left disabled:cursor-default ${current ? 'text-blue-950' : 'disabled:opacity-60'}`}
                  >
                    <span className="block truncate text-sm font-semibold">{project.fileName}</span>
                    <span className="mt-1 block truncate text-xs text-neutral-500">
                      {opening ? 'Opening…' : `${savedAgo(project.updatedAt)} · ${changeLabel(project)}`}
                    </span>
                  </button>
                  <div className="relative flex shrink-0 items-start pt-1.5">
                    <button
                      type="button"
                      aria-label={`More actions for ${project.fileName}`}
                      title={current ? 'Close this file first to delete its save' : `More actions for ${project.fileName}`}
                      disabled={current || openingId !== null}
                      onClick={() => setActionsId((id) => (id === project.id ? null : project.id))}
                      className="rounded px-2 py-1 text-lg leading-none text-neutral-500 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ⋯
                    </button>
                    {actionsId === project.id && !current && (
                      <div className="absolute right-1 top-9 z-20 w-40 rounded-md border border-neutral-200 bg-white p-1 shadow-lg">
                        <button
                          type="button"
                          onClick={() => void deleteProject(project)}
                          className="w-full rounded px-2 py-2 text-left text-sm font-medium text-red-700 hover:bg-red-50"
                        >
                          Delete saved file
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="shrink-0 border-t border-neutral-200 px-4 py-3 text-xs text-neutral-500">
        Saved only on this device.
      </p>
    </aside>
  );
}
