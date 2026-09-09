let pendingFiles: File[] = [];

export function setPendingFiles(files: File[]): void {
  pendingFiles = [...files];
}

export function takePendingFiles(): File[] {
  const files = pendingFiles;
  pendingFiles = [];
  return files;
}
