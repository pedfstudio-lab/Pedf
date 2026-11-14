/**
 * Plain words for failures, instead of the PDF libraries' technical messages, which mean nothing
 * to people and can reveal how the app works inside.
 */
export const OPEN_FAILED_MESSAGE = "This file couldn't be opened. It may be damaged or not a real PDF.";
export const EXPORT_FAILED_MESSAGE = "Your PDF couldn't be saved this time. Your edits are still here, so please try Download PDF again.";

/** Bigger files can run a browser tab out of memory; better a clear message than a crashed tab. */
export const MAX_PDF_BYTES = 200 * 1024 * 1024;
export const PDF_TOO_LARGE_MESSAGE = 'This PDF is larger than 200 MB, which is more than a browser can safely open. Try a smaller copy.';
