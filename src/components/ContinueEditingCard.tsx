import { useState } from 'react';
import { projectStore as defaultProjectStore } from '@/lib/projects/projectStore';
import type { ProjectMetadata, ProjectStore } from '@/lib/projects/projectStore';
import { savedAgo } from '@/lib/projects/savedTime';
import { useSavedProjects } from '@/lib/projects/useSavedProjects';

interface ContinueEditingCardProps {
  readonly store?: ProjectStore;
  onContinue(id: string): boolean | Promise<boolean>;
  /** The home page's slim one-row bar above the drop area, instead of the full card. */
  readonly compact?: boolean;
}

function ProjectSummary({
  project,
  newest,
  broken,
  compact = false,
  onContinue,
  onDelete,
}: {
  readonly project: ProjectMetadata;
  readonly newest: boolean;
  readonly broken: boolean;
  readonly compact?: boolean;
  onContinue(): void;
  onDelete(): void;
}) {
  const changes = `${project.changeCount} ${project.changeCount === 1 ? 'change' : 'changes'}`;
  if (compact) {
    return (
      <article className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-brand-200 bg-brand-50 px-3 py-2 text-left sm:gap-x-4 sm:px-4">
        {/* One row on a laptop and on a phone, so the drop area and cards still fit the first
            screen. Phones drop the details and shorten the buttons; their names stay full. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
          <p className="min-w-0 max-w-full truncate text-sm font-semibold text-brand-950">Continue editing <em>{project.fileName}</em>?</p>
          <p className="hidden text-xs text-neutral-600 sm:block">
            Saved {savedAgo(project.updatedAt)} · page {project.lastPage + 1} of {project.pageCount} · {changes}
          </p>
          {broken && <p className="mt-1 w-full text-sm font-medium text-danger-700">This saved file can&apos;t be opened.</p>}
        </div>
        {!broken && (
          <button
            type="button"
            onClick={onContinue}
            aria-label="Continue editing"
            className="shrink-0 rounded-full bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600 sm:px-4"
          >
            <span className="sm:hidden">Continue</span><span className="hidden sm:inline">Continue editing</span>
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete saved file"
          title="Delete saved file"
          className="min-h-9 min-w-9 shrink-0 rounded-full border border-danger-200 bg-white px-2 py-1.5 text-xs font-medium text-danger-700 hover:bg-danger-50 sm:min-h-0 sm:min-w-0 sm:px-3"
        >
          <span aria-hidden="true" className="sm:hidden">✕</span><span className="hidden sm:inline">Delete saved file</span>
        </button>
      </article>
    );
  }
  return (
    <article className={newest
      ? 'rounded-xl border border-brand-200 bg-brand-50 p-4 text-left shadow-sm'
      : 'rounded-lg border border-neutral-200 bg-white p-3 text-left'}
    >
      {newest && <p className="text-sm font-semibold text-brand-950">Continue editing <em>{project.fileName}</em>?</p>}
      {!newest && <p className="truncate text-sm font-semibold text-neutral-900">{project.fileName}</p>}
      <p className="mt-1 text-xs text-neutral-600">
        Saved {savedAgo(project.updatedAt)} · page {project.lastPage + 1} of {project.pageCount} · {changes}
      </p>
      {broken && <p className="mt-2 text-sm font-medium text-danger-700">This saved file can&apos;t be opened.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {!broken && (
          <button
            type="button"
            onClick={onContinue}
            className="rounded-md bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            Continue editing
          </button>
        )}
        {/* A full-size button at the far end, well away from Continue editing. */}
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto rounded-md border border-danger-200 bg-white px-3 py-2 text-sm font-medium text-danger-700 hover:bg-danger-50"
        >
          Delete saved file
        </button>
      </div>
    </article>
  );
}

export function ContinueEditingCard({
  store = defaultProjectStore,
  onContinue,
  compact = false,
}: ContinueEditingCardProps) {
  const [brokenIds, setBrokenIds] = useState<ReadonlySet<string>>(new Set());
  const { projects } = useSavedProjects(store);

  if (projects.length === 0) return null;
  const newest = projects[0];
  if (!newest) return null;

  const continueProject = async (project: ProjectMetadata) => {
    const loaded = await store.load(project.id);
    if (loaded.status !== 'ok' || !loaded.value) {
      setBrokenIds((ids) => new Set(ids).add(project.id));
      return;
    }
    const continued = await onContinue(project.id);
    if (!continued) setBrokenIds((ids) => new Set(ids).add(project.id));
  };
  const deleteProject = async (project: ProjectMetadata) => {
    if (!window.confirm(`Delete the saved edits for ${project.fileName}? This can't be undone.`)) return;
    await store.delete(project.id);
  };

  return (
    <section aria-label="Saved PDF projects" className={compact ? 'w-full space-y-2' : 'w-full max-w-xl space-y-3'}>
      <ProjectSummary
        project={newest}
        newest
        compact={compact}
        broken={brokenIds.has(newest.id)}
        onContinue={() => void continueProject(newest)}
        onDelete={() => void deleteProject(newest)}
      />
      {projects.length > 1 && (
        <details className={compact ? 'text-left' : 'rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-left'}>
          <summary className={compact ? 'cursor-pointer px-1 text-xs font-semibold text-neutral-700' : 'cursor-pointer text-sm font-semibold text-neutral-800'}>Other saved files</summary>
          <div className="mt-3 space-y-2">
            {projects.slice(1).map((project) => (
              <ProjectSummary
                key={project.id}
                project={project}
                newest={false}
                broken={brokenIds.has(project.id)}
                onContinue={() => void continueProject(project)}
                onDelete={() => void deleteProject(project)}
              />
            ))}
          </div>
        </details>
      )}
      {/* On the home page the privacy line under the drop area says this. */}
      {!compact && <p className="text-xs text-neutral-500">Saved only on this device.</p>}
    </section>
  );
}
