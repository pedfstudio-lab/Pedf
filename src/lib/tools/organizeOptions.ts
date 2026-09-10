import { parsePlan, type OrganizePlan } from './organizePlan';
import type { ToolOptions } from './types';

export interface OrganizeOptionsValue {
  [key: string]: unknown;
  plan: OrganizePlan;
}

export const DEFAULT_ORGANIZE_OPTIONS: OrganizeOptionsValue = { plan: [] };

export function parseOrganizeOptions(options: ToolOptions): OrganizeOptionsValue {
  return { plan: parsePlan(options.plan) };
}
