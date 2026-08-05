import { roundTripScenario } from './roundTrip';
import { englishEditScenario } from './englishEdit';
import { richTextEditScenario } from './richTextEdit';
import type { Scenario } from './runScenario';

/** Tasks 10 and 14 add feature-specific scenarios to this registry. */
export const SCENARIOS: Scenario[] = [
  roundTripScenario,
  englishEditScenario,
  richTextEditScenario,
];
