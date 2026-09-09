import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from './types';

const definition = (slug: string, hidden = false): ToolDefinition => ({
  slug, title: slug, description: 'Local tool', accepts: 'pdf', multiple: true,
  defaultOptions: {}, run: async () => [], hidden,
});

describe('tool registry', () => {
  beforeEach(() => vi.resetModules());

  it('finds registered tools and returns undefined for unknown slugs', async () => {
    const { registerTool, getTool } = await import('./registry');
    const tool = definition('merge');
    registerTool(tool);
    expect(getTool('merge')).toBe(tool);
    expect(getTool('unknown')).toBeUndefined();
  });

  it('lists visible tools in roadmap order, regardless of registration order', async () => {
    const { registerTool, listTools, getTool } = await import('./registry');
    ['compress', 'rotate', 'split', 'merge'].forEach((slug) => registerTool(definition(slug)));
    registerTool(definition('copy', true));
    expect(listTools().map(({ slug }) => slug)).toEqual(['merge', 'split', 'rotate', 'compress']);
    expect(getTool('copy')).toBeDefined();
    listTools().pop();
    expect(listTools()).toHaveLength(4);
  });

  it('rejects duplicate and unsafe slugs', async () => {
    const { registerTool } = await import('./registry');
    registerTool(definition('merge'));
    expect(() => registerTool(definition('merge'))).toThrow('already registered');
    expect(() => registerTool(definition('../bad'))).toThrow('Invalid tool slug');
  });
});
