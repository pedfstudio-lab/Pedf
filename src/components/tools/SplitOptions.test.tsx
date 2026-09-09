// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPLIT_OPTIONS } from '@/lib/tools/splitOptions';
import { SplitOptions } from './SplitOptions';

afterEach(cleanup);

describe('SplitOptions', () => {
  it('starts with custom ranges and exposes its merge checkbox', () => {
    const onChange = vi.fn();
    render(<SplitOptions options={DEFAULT_SPLIT_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    expect((screen.getByRole('radio', { name: /Custom ranges/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Pages or ranges'), { target: { value: '1-3, 5' } });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SPLIT_OPTIONS, ranges: '1-3, 5' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Merge selected ranges into one PDF' }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SPLIT_OPTIONS, mergeRanges: true });
  });

  it('switches to every page without showing custom-only controls', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SplitOptions options={DEFAULT_SPLIT_OPTIONS} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.click(screen.getByRole('radio', { name: /Every page/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SPLIT_OPTIONS, mode: 'every-page' });
    rerender(<SplitOptions options={{ ...DEFAULT_SPLIT_OPTIONS, mode: 'every-page' }} onChange={onChange} inputs={[]} disabled={false} />);
    expect(screen.queryByLabelText('Pages or ranges')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('edits the group size in every-N mode', () => {
    const onChange = vi.fn();
    render(<SplitOptions options={{ ...DEFAULT_SPLIT_OPTIONS, mode: 'every-n' }} onChange={onChange} inputs={[]} disabled={false} />);
    fireEvent.change(screen.getByLabelText('Pages per PDF'), { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SPLIT_OPTIONS, mode: 'every-n', everyN: 4 });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('disables every control while processing', () => {
    render(<SplitOptions options={DEFAULT_SPLIT_OPTIONS} onChange={vi.fn()} inputs={[]} disabled />);
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
  });
});
