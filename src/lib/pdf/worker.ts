import * as pdfjs from 'pdfjs-dist';
// The `?url` asset import lets Vite fingerprint + serve the worker and guarantees
// the worker build matches the API build. This is the reliable pattern on Windows
// (avoids the `new URL(..., import.meta.url)` backslash pitfalls).
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
