// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ToolsApp from './ToolsApp';
import { registerTool } from '@/lib/tools/registry';

afterEach(cleanup);

describe('ToolsApp index and lookup', () => {
  it('shows available registered tools in the index but hides Copy PDF', () => {
    registerTool({ slug: 'example', title: 'Example PDF tool', description: 'An example.', accepts: 'pdf', multiple: false, defaultOptions: {}, run: async () => [] });
    render(<ToolsApp />);
    expect(screen.getByRole('link', { name: /Example PDF tool/ }).getAttribute('href')).toBe('/tools/example');
    expect(screen.getByRole('link', { name: /Edit PDF/ }).getAttribute('href')).toBe('/app');
    expect(screen.queryByText('Copy PDF')).toBeNull();
  });

  it('falls back to the tools index for an unknown slug', () => {
    render(<ToolsApp slug="does-not-exist" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('PDF tools');
  });

  it('keeps the hidden Copy PDF page reachable for verification', () => {
    render(<ToolsApp slug="copy" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Copy PDF');
    expect(screen.getByRole('button', { name: /Drop PDF files here/ })).toBeTruthy();
  });
});
