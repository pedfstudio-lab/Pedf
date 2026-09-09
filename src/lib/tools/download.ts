import { zipSync } from 'fflate';
import { safeFilename } from './pdfIo';
import type { ToolOutput } from './types';

export function downloadBytes(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename(name);
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give the browser time to start consuming the download before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function zipOutputs(outputs: ToolOutput[]): Uint8Array {
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const output of outputs) {
    const original = safeFilename(output.name);
    let name = original;
    let suffix = 2;
    // Never silently replace an output when inputs share a name.
    while (Object.hasOwn(entries, name)) {
      const dot = original.lastIndexOf('.');
      name = dot > 0 ? `${original.slice(0, dot)} (${suffix++})${original.slice(dot)}` : `${original} (${suffix++})`;
    }
    entries[name] = output.bytes;
  }
  return zipSync(entries, { level: 0 });
}
