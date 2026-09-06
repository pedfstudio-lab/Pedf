/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FontSizeCombobox } from '@/components/FontSizeCombobox';
import { FONT_SIZE_PRESETS } from '@/lib/edit/fontSize';

afterEach(cleanup);

describe('FontSizeCombobox', () => {
  it('shows every preset from the caret and applies a picked size', () => {
    const onApply = vi.fn();
    render(<FontSizeCombobox value={12} onApply={onApply} />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose font size' }));

    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(
      FONT_SIZE_PRESETS.map(String),
    );

    fireEvent.click(screen.getByRole('option', { name: '24' }));

    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply).toHaveBeenCalledWith(24);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Font size' }) as HTMLInputElement).value)
      .toBe('24');
  });

  it('applies a typed decimal size on Enter', () => {
    const onApply = vi.fn();
    render(<FontSizeCombobox value={11} onApply={onApply} />);
    const input = screen.getByRole('combobox', { name: 'Font size' }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '12.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onApply).toHaveBeenCalledWith(12.5);
    expect(input.value).toBe('12.5');
  });

  it('applies a typed pt size on blur', () => {
    const onApply = vi.fn();
    render(<FontSizeCombobox value={11} onApply={onApply} />);
    const input = screen.getByRole('combobox', { name: 'Font size' }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: ' 14pt ' } });
    fireEvent.blur(input);

    expect(onApply).toHaveBeenCalledWith(14);
    expect(input.value).toBe('14');
  });

  it('resets invalid input without changing the size', () => {
    const onApply = vi.fn();
    render(<FontSizeCombobox value={16} onApply={onApply} />);
    const input = screen.getByRole('combobox', { name: 'Font size' }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onApply).not.toHaveBeenCalled();
    expect(input.value).toBe('16');
  });

  it('reverts the draft and closes the list on Escape', () => {
    const onApply = vi.fn();
    render(<FontSizeCombobox value={18} onApply={onApply} />);
    const input = screen.getByRole('combobox', { name: 'Font size' }) as HTMLInputElement;

    fireEvent.click(screen.getByRole('button', { name: 'Choose font size' }));
    fireEvent.change(input, { target: { value: '32' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onApply).not.toHaveBeenCalled();
    expect(input.value).toBe('18');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
