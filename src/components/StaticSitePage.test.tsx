// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StaticSitePage } from './StaticSitePage';

afterEach(cleanup);

describe('Privacy page', () => {
  it('says plainly what leaves the device, including the visitor counter', () => {
    render(<StaticSitePage kind="privacy" />);
    const page = screen.getByRole('main').textContent ?? '';
    expect(page).toContain('Your PDF is not uploaded');
    expect(page).toContain('Sarvam AI');
    // Cloudflare Web Analytics is on, so the page must not claim "no analytics".
    expect(page).not.toMatch(/no analytics/i);
    expect(page).toContain('Cloudflare Web Analytics');
    expect(page).toContain('without cookies');
    expect(page).toContain('never sees your PDFs');
    expect(page).toContain('There are no accounts');
  });
});
