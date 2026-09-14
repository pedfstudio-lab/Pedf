import { useState } from 'react';
import { projectStore as defaultProjectStore } from '@/lib/projects/projectStore';
import type { ProjectMetadata, ProjectStore } from '@/lib/projects/projectStore';
import { savedAgo } from '@/lib/projects/savedTime';
import { useSavedProjects } from '@/lib/projects/useSavedProjects';

interface ContinueEditingCardProps {
  readonly store?: ProjectStore;
  onContinue(id: string): boolean | Promise<boolean>;
}

function ProjectSummary({
  project,
  newest,
  broken,
  onContinue,
  onDelete,
}: {
  readonly project: ProjectMetadata;
  readonly newest: boolean;
  readonly broken: boolean;
  onContinue(): void;
  onDelete(): void;
}) {
  const changes = `${project.changeCount} ${project.changeCount === 1 ? 'change' : 'changes'}`;
  return (
    <article className={newest
      ? 'rounded-xl border border-blue-200 bg-blue-50 p-4 text-left shadow-sm'
      : 'rounded-lg border border-neutral-200 bg-white p-3 text-left'}
    >
      {newest && <p className="text-sm font-semibold text-blue-950">Continue editing <em>{project.fileName}</em>?</p>}
      {!newest && <p className="truncate text-sm font-semibold text-neutral-900">{project.fileName}</p>}
      <p className="mt-1 text-xs text-neutral-600">
        Saved {savedAgo(project.updatedAt)} · page {project.lastPage + 1} of {project.pageCount} · {changes}
      </p>
      {broken && <p className="mt-2 text-sm font-medium text-red-700">This saved file can&apos;t be opened.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {!broken && (
          <button
            type="button"
            onClick={onContinue}
            className="rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-600"
          >
            Continue editing
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="text-sm font-medium text-red-700 underline-offset-2 hover:underline"
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
    <section aria-label="Saved PDF projects" className="w-full max-w-xl space-y-3">
      <ProjectSummary
        project={newest}
        newest
        broken={brokenIds.has(newest.id)}
        onContinue={() => void continueProject(newest)}
        onDelete={() => void deleteProject(newest)}
      />
      {projects.length > 1 && (
        <details className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-left">
          <summary className="cursor-pointer text-sm font-semibold text-neutral-800">Other saved files</summary>
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
      <p className="text-xs text-neutral-500">Saved only on this device.</p>
    </section>
  );
}
