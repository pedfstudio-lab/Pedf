import { loadPdfLib, outputName, savePdf } from './pdfIo';
import type { ToolDefinition } from './types';

/** Hidden smoke-test tool. Real processing tools are separate roadmap tasks. */
export const copyTool: ToolDefinition = {
  slug: 'copy', title: 'Copy PDF',
  description: 'Create a fresh PDF copy on your computer. Your original stays unchanged.',
  accepts: 'pdf', multiple: true, hidden: true, defaultOptions: {},
  async run(inputs, _options, { signal, onProgress }) {
    const outputs = [];
    for (const [index, file] of inputs.entries()) {
      signal.throwIfAborted();
      onProgress(index, inputs.length, `Copying ${file.name}`);
      const doc = await loadPdfLib(file);
      signal.throwIfAborted();
      const bytes = await savePdf(doc);
      signal.throwIfAborted();
      outputs.push({ name: outputName(file, 'copy'), bytes, mime: 'application/pdf' });
      onProgress(index + 1, inputs.length, `Copied ${file.name}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    return outputs;
  },
};
