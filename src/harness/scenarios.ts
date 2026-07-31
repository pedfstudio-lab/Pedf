import { roundTripScenario } from './roundTrip';
import type { Scenario } from './runScenario';

/** Tasks 10 and 14 add feature-specific scenarios to this registry. */
export const SCENARIOS: Scenario[] = [roundTripScenario];
