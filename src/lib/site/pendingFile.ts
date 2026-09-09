import { setPendingFiles, takePendingFiles } from './pendingFiles';

export function setPendingFile(file: File): void {
  setPendingFiles([file]);
}

export function takePendingFile(): File | undefined {
  return takePendingFiles()[0];
}
