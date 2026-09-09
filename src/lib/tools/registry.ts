import type { ToolDefinition } from './types';

const roadmap = [
  'merge', 'split', 'jpg-to-pdf', 'pdf-to-jpg', 'rotate', 'organize',
  'page-numbers', 'watermark', 'repair', 'sign', 'compress',
];
const tools = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool.slug)) throw new Error('Invalid tool slug.');
  if (tools.has(tool.slug)) throw new Error(`Tool already registered: ${tool.slug}`);
  tools.set(tool.slug, tool);
}

export function getTool(slug: string): ToolDefinition | undefined {
  return tools.get(slug);
}

export function listTools(): ToolDefinition[] {
  const rank = (slug: string) => {
    const index = roadmap.indexOf(slug);
    return index < 0 ? roadmap.length : index;
  };
  return [...tools.values()].filter((tool) => !tool.hidden)
    .sort((a, b) => rank(a.slug) - rank(b.slug));
}
