// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolOptions } from '@/lib/tools/types';
import { LockOptions } from './LockOptions';

afterEach(cleanup);
function Fixture() {
  const [options, onChange] = useState<ToolOptions>({ password: '', confirmation: '' });
  return <LockOptions options={options} onChange={onChange} inputs={[]} disabled={false} />;
}
describe('Lock PDF options', () => {
  it('masks both passwords by default, allows an explicit reveal and preserves exact input', () => {
    render(<Fixture />);
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    const confirmation = screen.getByLabelText('Confirm password') as HTMLInputElement;
    fireEvent.change(password, { target: { value: ' phrase with spaces ' } });
    fireEvent.change(confirmation, { target: { value: ' phrase with spaces ' } });
    expect(password.value).toBe(' phrase with spaces ');
    expect(password.type).toBe('password'); expect(confirmation.type).toBe('password');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show passwords' }));
    expect(password.type).toBe('text'); expect(confirmation.type).toBe('text');
    expect(password.autocomplete).toBe('off');
    expect(screen.getByText(/cannot recover it/)).toBeTruthy();
  });
  it('disables the inputs and reveal control during processing', () => {
    render(<LockOptions options={{}} onChange={vi.fn()} inputs={[]} disabled />);
    expect(screen.getByRole('group').hasAttribute('disabled')).toBe(true);
  });
});
