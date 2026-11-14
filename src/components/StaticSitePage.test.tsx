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

describe('Terms page', () => {
  it('is the real terms, not the draft placeholder, with the points HighPal needs', () => {
    render(<StaticSitePage kind="terms" />);
    const main = screen.getByRole('main');
    const page = main.textContent ?? '';
    expect(page).not.toMatch(/draft|review before launch/i);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The rules, in plain words.');
    expect(page).toContain('run by Utkarsh Taneja, an individual based in Alwar, Rajasthan, India');
    // Editor first, then talking to the document.
    expect(page).toContain('is a professional PDF editor at highpal.ai');
    expect(page).toContain('talk to, chat with and ask questions about your document, by typing or by voice');
    expect(page).toMatch(/Last updated: \d{1,2} \w+ 20\d\d/);
    // The clauses that matter most for a PDF editor with AI features.
    expect(page).toContain('forge, falsify or alter documents');
    expect(page).toContain('AI answers and translations can be wrong');
    expect(page).toContain('nothing will be charged without your agreement');
    expect(page).toContain('courts at Alwar, Rajasthan');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(13);
    expect(screen.getByRole('link', { name: 'Privacy page' }).getAttribute('href')).toBe('/privacy');
    expect(screen.getByRole('link', { name: 'pedf.studio@gmail.com' }).getAttribute('href')).toBe('mailto:pedf.studio@gmail.com');
  });
});
