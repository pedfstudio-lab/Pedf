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
    expect(screen.getByRole('link', { name: /Merge PDF/ }).getAttribute('href')).toBe('/tools/merge');
    expect(screen.getByRole('link', { name: /Split PDF/ }).getAttribute('href')).toBe('/tools/split');
    expect(screen.getByRole('link', { name: /JPG to PDF/ }).getAttribute('href')).toBe('/tools/jpg-to-pdf');
    expect(screen.getByRole('link', { name: /PDF to JPG/ }).getAttribute('href')).toBe('/tools/pdf-to-jpg');
    expect(screen.getByRole('link', { name: /Rotate PDF/ }).getAttribute('href')).toBe('/tools/rotate');
    expect(screen.getByRole('link', { name: /Organize PDF/ }).getAttribute('href')).toBe('/tools/organize');
    expect(screen.getByRole('link', { name: /Watermark PDF/ }).getAttribute('href')).toBe('/tools/watermark');
    expect(screen.getByRole('link', { name: /Repair PDF/ }).getAttribute('href')).toBe('/tools/repair');
    expect(document.querySelectorAll('.tool-card')).toHaveLength(10);
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

  it('opens Merge PDF with a two-file minimum', () => {
    render(<ToolsApp slug="merge" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Merge PDF');
    expect(screen.getByText('Choose at least 2 files to continue.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Merge PDF' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens Split PDF with its custom-range options', () => {
    render(<ToolsApp slug="split" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Split PDF');
    expect(screen.getByRole('radio', { name: /Custom ranges/ })).toBeTruthy();
    expect(screen.getByLabelText('Pages or ranges')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Merge selected ranges into one PDF' })).toBeTruthy();
  });

  it('opens JPG to PDF with image inputs and layout options', () => {
    render(<ToolsApp slug="jpg-to-pdf" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('JPG to PDF');
    expect(screen.getByRole('button', { name: /Drop image files here/ })).toBeTruthy();
    expect(screen.getByLabelText('Page size')).toBeTruthy();
    expect(screen.getByLabelText('Orientation')).toBeTruthy();
  });

  it('opens PDF to JPG with one PDF input and image options', () => {
    render(<ToolsApp slug="pdf-to-jpg" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('PDF to JPG');
    expect(screen.getByRole('button', { name: /Drop a PDF file here/ })).toBeTruthy();
    expect(screen.getByLabelText('Format')).toBeTruthy();
    expect(screen.getByLabelText('Quality')).toBeTruthy();
    expect(screen.getByLabelText('Pages')).toBeTruthy();
  });

  it('opens Rotate PDF with angle and page-range options', () => {
    render(<ToolsApp slug="rotate" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Rotate PDF');
    expect(screen.getByRole('button', { name: /Drop a PDF file here/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotate left' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotate right' })).toBeTruthy();
    expect(screen.getByLabelText('Pages')).toBeTruthy();
    const rotate = screen.getByRole('button', { name: 'Rotate PDF' }) as HTMLButtonElement;
    expect(rotate.disabled).toBe(true);
    expect(rotate.title).toBe('Click Left or Right to choose the direction first.');
  });

  it('opens Organize PDF with a page grid and disabled run action', () => {
    render(<ToolsApp slug="organize" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Organize PDF');
    expect(screen.getByRole('button', { name: /Drop PDF files here/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Pages' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Organize PDF' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens Watermark PDF with text, placement and preview options', () => {
    render(<ToolsApp slug="watermark" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Watermark PDF');
    expect(screen.getByRole('button', { name: /Drop a PDF file here/ })).toBeTruthy();
    expect(screen.getByLabelText('Watermark text')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Watermark position' })).toBeTruthy();
    expect(screen.getByText('Choose a PDF to preview the watermark.')).toBeTruthy();
  });

  it('opens Repair PDF with one-file checking and a disabled action', () => {
    render(<ToolsApp slug="repair" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Repair PDF');
    expect(screen.getByRole('button', { name: /Drop a PDF file here/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Repair PDF' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
