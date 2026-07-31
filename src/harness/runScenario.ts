import { exportPdf } from '@/lib/export/exportPdf';
import type { EditDocument } from '@/lib/export/types';
import { diffImageData } from './pixelDiff';
import { renderPdfToImageData } from './renderPdf';

export interface ScenarioSetup {
  readonly doc: EditDocument;
  readonly expectedBytes: Uint8Array;
}

export interface Scenario {
  readonly name: string;
  readonly tolerance: number;
  setup(): Promise<ScenarioSetup>;
}

export interface PageResult {
  readonly pageIndex: number;
  readonly ratio: number;
  readonly expected: ImageData;
  readonly actual: ImageData;
  readonly diff: ImageData;
}

export interface ScenarioResult {
  readonly name: string;
  readonly tolerance: number;
  readonly ratio: number;
  readonly pass: boolean;
  readonly pages: PageResult[];
  readonly error?: string;
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  try {
    const { doc, expectedBytes } = await scenario.setup();
    const exported = await exportPdf(doc);
    const [expectedPages, actualPages] = await Promise.all([
      renderPdfToImageData(expectedBytes),
      renderPdfToImageData(exported.bytes),
    ]);

    if (expectedPages.length !== actualPages.length) {
      throw new Error(
        `page count mismatch: expected ${expectedPages.length}, got ${actualPages.length}`,
      );
    }

    const pages = expectedPages.map((expected, pageIndex): PageResult => {
      const actual = actualPages[pageIndex];
      if (!actual) throw new Error(`missing rendered output for page ${pageIndex + 1}`);
      const { ratio, diff } = diffImageData(expected, actual);
      return { pageIndex, ratio, expected, actual, diff };
    });
    const ratio = pages.reduce((maximum, page) => Math.max(maximum, page.ratio), 0);

    return {
      name: scenario.name,
      tolerance: scenario.tolerance,
      ratio,
      pass: ratio <= scenario.tolerance,
      pages,
    };
  } catch (error) {
    return {
      name: scenario.name,
      tolerance: scenario.tolerance,
      ratio: 1,
      pass: false,
      pages: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
