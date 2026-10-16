import { describe, it } from 'vitest';
import { probeFonts, publishMeasuredSurvey, surveyFonts, verifySurveyAssumptions } from './task78Survey.local';

describe('Task 78 measurement accounting', () => {
  it('keeps raw PDF types, genuine families and observed advances distinct', verifySurveyAssumptions);
});

describe.runIf(process.env.TASK78_FONTS === '1')('Task 78 Change 0 (measurement only)', () => {
  it('publishes the used fonts, fallback widths and paragraph simulations', { timeout: 1_800_000 }, surveyFonts);
});

describe.runIf(process.env.TASK78_PROBE === '1')('Task 78 metadata audit', () => {
  it('inspects original resource names and Unicode maps', { timeout: 120_000 }, probeFonts);
});

describe.runIf(process.env.TASK78_PUBLISH === '1')('Task 78 table publication', () => {
  it('reaggregates measured rows and verifies unchanged source hashes', { timeout: 120_000 }, publishMeasuredSurvey);
});
