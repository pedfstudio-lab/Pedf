import { useCallback, useEffect, useRef, useState } from 'react';
import { installHiddenRenderShim } from './env';
import { runScenario } from './runScenario';
import type { ScenarioResult } from './runScenario';
import { SCENARIOS } from './scenarios';

interface HarnessSummary {
  readonly name: string;
  readonly ratio: number;
  readonly pass: boolean;
}

declare global {
  interface Window {
    __HARNESS_RESULT__?: HarnessSummary[];
  }
}

interface ImageCanvasProps {
  readonly label: string;
  readonly image: ImageData;
}

function ImageCanvas({ label, image }: ImageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.putImageData(image, 0, 0);
  }, [image]);

  return (
    <figure className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <figcaption className="border-b border-neutral-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </figcaption>
      <canvas ref={canvasRef} className="block h-auto w-full" />
    </figure>
  );
}

function ResultCard({ result }: { readonly result: ScenarioResult }) {
  const statusClasses = result.pass
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : 'border-red-200 bg-red-50 text-red-800';

  return (
    <article className={`rounded-xl border p-5 shadow-sm ${statusClasses}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{result.name}</h2>
          <p className="mt-1 font-mono text-sm">
            ratio {result.ratio.toFixed(6)} · tolerance {result.tolerance.toFixed(6)}
          </p>
        </div>
        <span className="rounded-full border border-current px-3 py-1 text-sm font-bold">
          {result.pass ? 'PASS' : 'FAIL'}
        </span>
      </div>

      {result.error && (
        <pre className="mt-4 overflow-auto whitespace-pre-wrap rounded-lg bg-red-950 p-3 text-xs text-red-50">
          {result.error}
        </pre>
      )}

      {result.pages.map((page) => (
        <section key={page.pageIndex} className="mt-5 border-t border-current/20 pt-5">
          <div className="mb-3 flex items-center justify-between gap-3 text-sm">
            <h3 className="font-semibold">Page {page.pageIndex + 1}</h3>
            <span className="font-mono">diff {page.ratio.toFixed(6)}</span>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <ImageCanvas label="Expected" image={page.expected} />
            <ImageCanvas label="Actual" image={page.actual} />
            <ImageCanvas label="Diff" image={page.diff} />
          </div>
        </section>
      ))}
    </article>
  );
}

export default function VerifyPage() {
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [running, setRunning] = useState(false);
  const runIdRef = useRef(0);

  const runAll = useCallback(async () => {
    const runId = ++runIdRef.current;
    delete window.__HARNESS_RESULT__;
    setRunning(true);
    setResults([]);

    const nextResults = await Promise.all(SCENARIOS.map(runScenario));
    if (runId !== runIdRef.current) return;

    setResults(nextResults);
    setRunning(false);
    window.__HARNESS_RESULT__ = nextResults.map(({ name, ratio, pass }) => ({
      name,
      ratio,
      pass,
    }));
  }, []);

  useEffect(() => {
    installHiddenRenderShim();
    void runAll();
    return () => {
      runIdRef.current += 1;
    };
  }, [runAll]);

  return (
    <main className="min-h-full bg-neutral-100 p-4 text-neutral-900 sm:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-neutral-500">
              DesiPDF development harness
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Export verification</h1>
            <p className="mt-2 max-w-2xl text-sm text-neutral-600">
              Expected and exported PDFs are rendered through the same PDF.js pipeline at DPR 1.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runAll()}
            disabled={running}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-700 disabled:cursor-wait disabled:bg-neutral-400"
          >
            {running ? 'Running…' : 'Run all'}
          </button>
        </header>

        {running && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm font-medium text-blue-800">
            Rendering and comparing scenarios…
          </div>
        )}

        {!running && results.length > 0 && (
          <div className="space-y-6">
            {results.map((result) => (
              <ResultCard key={result.name} result={result} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
