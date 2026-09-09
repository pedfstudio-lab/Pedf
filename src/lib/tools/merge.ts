import { PDFDocument } from 'pdf-lib';
import { loadPdfLib, outputName, PDF_ERRORS, savePdf } from './pdfIo';
import { preserveMergeForms } from './mergeForms';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export const MERGE_FORM_WARNING = 'Form fields from more than one file may clash';
export const MERGE_MIN_FILES_ERROR = 'Choose at least 2 PDF files to merge.';

export async function run(inputs: File[], _options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  const { signal, onProgress, onWarning } = ctx;
  signal.throwIfAborted();
  if (inputs.length < 2) throw new Error(MERGE_MIN_FILES_ERROR);
  const output = await PDFDocument.create();
  let warned = false;
  for (const [index, file] of inputs.entries()) {
    signal.throwIfAborted();
    onProgress(index, inputs.length, `Merging ${file.name}`);
    const source = await loadPdfLib(file);
    signal.throwIfAborted();
    const hasForm = !!source.catalog.AcroForm();
    if (hasForm && !warned) { onWarning?.(MERGE_FORM_WARNING); warned = true; }
    try {
      const pages = await output.copyPages(source, source.getPageIndices());
      signal.throwIfAborted();
      for (const page of pages) output.addPage(page);
      if (hasForm) preserveMergeForms(source, output, pages, index);
    } catch (error) {
      signal.throwIfAborted();
      // Malformed objects can fail during page copying as well as initial parsing.
      if (error instanceof Error) throw new Error(PDF_ERRORS.corrupt);
      throw error;
    }
    onProgress(index + 1, inputs.length, index === inputs.length - 1 ? 'Preparing merged PDF…' : `Added ${file.name}`);
    // Let the UI paint progress and deliver Cancel between source documents.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  const bytes = await savePdf(output);
  signal.throwIfAborted();
  onProgress(inputs.length, inputs.length, 'Merged PDF ready');
  return [{ name: inputs.length > 3 ? 'merged.pdf' : outputName(inputs[0]!, 'merged'), bytes, mime: 'application/pdf' }];
}

export const mergeTool: ToolDefinition = {
  slug: 'merge', title: 'Merge PDF',
  description: 'Combine two or more PDFs into one, in the order you choose.',
  accepts: 'pdf', multiple: true, minInputs: 2, defaultOptions: {}, icon: '⊕', run,
};
