import { describe, expect, it } from 'vitest';
import { fileKey } from './organizePlan';
import { DEFAULT_REPAIR_OPTIONS, parseRepairOptions, repairProblem } from './repairOptions';

const file = new File(['%PDF-1.7'], 'document.pdf', { type: 'application/pdf', lastModified: 7 });
const key = fileKey(file);

describe('repair options', () => {
  it('uses safe defaults and discards malformed stored inspection data', () => {
    expect(parseRepairOptions({})).toEqual(DEFAULT_REPAIR_OPTIONS);
    expect(parseRepairOptions({ repairAnyway: 'yes', acceptSignatureLoss: 1, inspection: { kind: 'healthy' } }))
      .toEqual(DEFAULT_REPAIR_OPTIONS);
  });

  it('waits for a current inspection', () => {
    expect(repairProblem({}, [file])).toBe('Checking your file…');
    expect(repairProblem({ inspection: { kind: 'healthy', pageCount: 1, signed: false, fileKey: 'stale' } }, [file]))
      .toBe('Checking your file…');
  });

  it('explains unsupported input and locked PDFs', () => {
    expect(repairProblem({ inspection: { kind: 'not-pdf', fileKey: key } }, [file]))
      .toBe("This isn't a PDF file. It may be a web page or another file saved with a .pdf name.");
    expect(repairProblem({ inspection: { kind: 'locked', fileKey: key } }, [file]))
      .toBe("This file is password-protected or restricted, not damaged. Repair can't change it.");
  });

  it('protects healthy and signed files unless the user confirms', () => {
    const healthy = { kind: 'healthy', pageCount: 1, signed: false, fileKey: key };
    expect(repairProblem({ inspection: healthy }, [file])).toBe('This file looks healthy — no repair needed.');
    expect(repairProblem({ inspection: healthy, repairAnyway: true }, [file])).toBeUndefined();

    const signed = { kind: 'damaged', pageCount: 1, badPages: [], problems: ["the file's index is broken"], signed: true, fileKey: key };
    expect(repairProblem({ inspection: signed }, [file]))
      .toBe('Tick the box to confirm the digital signature will stop being valid.');
    expect(repairProblem({ inspection: signed, acceptSignatureLoss: true }, [file])).toBeUndefined();
  });
});
