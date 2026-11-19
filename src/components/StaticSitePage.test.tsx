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
    // The human check in front of the AI features, and its pass cookie.
    expect(page).toContain('Cloudflare Turnstile checks that you\'re a person');
    expect(page).toContain('security-only pass for 30 minutes');
    expect(page).toContain('Turnstile never sees your PDFs or questions');
    // Cloudflare's Turnstile dashboard shows visitors' internet addresses, so the page says so.
    expect(page).toContain('Cloudflare sees technical details such as your internet address and browser');
  });

  it('covers what privacy laws ask for: who, why and on what basis, where, how long, rights, children, date', () => {
    render(<StaticSitePage kind="privacy" />);
    const page = screen.getByRole('main').textContent ?? '';
    expect(page).toMatch(/Last updated: \d{1,2} \w+ 20\d\d/);
    expect(page).toContain('This page covers highpal.ai.');
    // Who is responsible, the grievance contact (India's DPDP Act), and what happens to emails.
    expect(page).toContain('run by Utkarsh Taneja, an individual based in Alwar, Rajasthan, India');
    expect(page).toContain('grievance contact');
    expect(page).toContain('we use your email address and message only to reply');
    expect(screen.getAllByRole('link', { name: 'pedf.studio@gmail.com' })[0]!.getAttribute('href')).toBe('mailto:pedf.studio@gmail.com');
    // Saved files and signatures stay local; the browser storage used, and the only cookie.
    expect(page).toContain('the signatures you save are kept only in this browser');
    expect(page).toContain('IndexedDB for saved files, and localStorage for saved signatures and settings');
    expect(page).toContain('The only cookie HighPal sets is the 30-minute security pass');
    expect(page).toContain('delete a saved signature in the Sign window');
    // Said once, in the opening, not repeated in section 2.
    expect(page).not.toContain('Nothing here is uploaded');
    // Consent for the AI features, the microphone, and a link to Sarvam AI's own policy.
    expect(page).toContain('By choosing one of these features, you agree to this.');
    expect(page).toContain('Your microphone is only used while Talk or voice input is switched on');
    expect(screen.getByRole('link', { name: 'Sarvam AI’s privacy policy' }).getAttribute('href')).toBe('https://www.sarvam.ai/privacy-policy');
    expect(page).not.toContain('Nothing is stored');
    // The server's short use of the internet address for usage limits, and Cloudflare's own logs.
    expect(page).toContain('briefly uses your internet address to limit how often');
    expect(page).toContain('HighPal keeps no server logs');
    expect(screen.getByRole('link', { name: 'its privacy policy' }).getAttribute('href')).toBe('https://www.cloudflare.com/privacypolicy/');
    // GDPR: the legal basis for each use.
    expect(page).toContain('your consent, given when you choose chat, voice or Translate');
    expect(page).toContain('keeping HighPal secure and fair to everyone (legitimate interests)');
    expect(page).toContain('We don’t sell your data, show ads, or build a profile about you');
    // Where and how long. Sarvam support confirmed 45 days for its Model APIs; no stronger promise until that changes.
    expect(page).toContain('Sarvam AI is based in India');
    expect(page).toContain('EU–US Data Privacy Framework');
    expect(page).toContain('HighPal itself keeps none of this');
    expect(page).toContain('Sarvam AI currently keeps it for up to 45 days, then deletes it');
    expect(page).not.toMatch(/no retention|zero data retention|1 day/i);
    expect(page).toContain('Emails you send us are kept only until your request is sorted out');
    // Rights in the law's own words, children.
    expect(page).toContain('withdraw your consent at any time, as easily as you gave it');
    expect(page).toContain('HighPal can’t see or delete your files');
    expect(page).toContain('ask to see, correct or delete what you sent');
    expect(page).toContain('We reply to every request within 24–48 hours');
    expect(page).not.toContain('30 days');
    expect(page).toContain('Data Protection Board of India');
    expect(page).toContain('aged 18 or over');
    // The "Last updated" date does the job of a "changes to this page" section.
    expect(page).not.toContain('Changes to this page');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(8);
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
    expect(page).toContain('a quick automatic check (Cloudflare Turnstile) may confirm you’re a person');
    expect(page).toContain('editing and the PDF tools keep working');
    expect(page).toContain('nothing will be charged without your agreement');
    expect(page).toContain('courts at Alwar, Rajasthan');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(13);
    expect(screen.getByRole('link', { name: 'Privacy page' }).getAttribute('href')).toBe('/privacy');
    expect(screen.getByRole('link', { name: 'pedf.studio@gmail.com' }).getAttribute('href')).toBe('mailto:pedf.studio@gmail.com');
  });
});
