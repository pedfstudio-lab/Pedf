import { loadDocument } from '@/lib/pdf/loadDocument';
import type { Scenario } from './runScenario';

export const roundTripScenario: Scenario = {
  name: 'Round-trip (zero edits)',
  tolerance: 0.001,
  async setup() {
    const response = await fetch(`${import.meta.env.BASE_URL}samples/sample-basic.pdf`);
    if (!response.ok) {
      throw new Error(`sample PDF request failed: HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const loaded = await loadDocument(bytes);
    await loaded.doc.destroy();

    return {
      doc: {
        originalBytes: loaded.originalBytes,
        edits: [],
        pages: loaded.pages,
      },
      expectedBytes: loaded.originalBytes.slice(),
    };
  },
};
