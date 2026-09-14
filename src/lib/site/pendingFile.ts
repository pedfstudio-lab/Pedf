import { setPendingFiles, takePendingFiles } from './pendingFiles';

let pendingProject: string | undefined;

export function setPendingFile(file: File): void {
  setPendingFiles([file]);
}

export function takePendingFile(): File | undefined {
  return takePendingFiles()[0];
}

export function setPendingProject(id: string): void {
  pendingProject = id;
}

export function takePendingProject(): string | undefined {
  const id = pendingProject;
  pendingProject = undefined;
  return id;
}
