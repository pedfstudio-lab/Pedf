let pendingFile: File | undefined;

export function setPendingFile(file: File): void {
  pendingFile = file;
}

export function takePendingFile(): File | undefined {
  const file = pendingFile;
  pendingFile = undefined;
  return file;
}
