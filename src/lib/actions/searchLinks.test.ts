import { describe, expect, it } from 'vitest';
import { googleMapsUrl, googleSearchUrl } from './searchLinks';

describe('searchLinks', () => {
  it('builds a Google meaning search from only the normalized snippet', () => {
    const url = new URL(googleSearchUrl('  New\n\tDelhi   '));

    expect(url.origin).toBe('https://www.google.com');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('meaning of New Delhi');
    expect(url.searchParams.size).toBe(1);
  });

  it('builds a Google Maps search with the expected API parameters', () => {
    const url = new URL(googleMapsUrl('  Ubud / Canggu  '));

    expect(url.origin).toBe('https://www.google.com');
    expect(url.pathname).toBe('/maps/search/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('query')).toBe('Ubud / Canggu');
    expect(url.searchParams.size).toBe(2);
  });

  it('caps the normalized snippet at 200 characters before encoding', () => {
    const input = `  ${'place '.repeat(60)}  `;
    const searchQuery = new URL(googleSearchUrl(input)).searchParams.get('q') ?? '';
    const mapsQuery = new URL(googleMapsUrl(input)).searchParams.get('query') ?? '';

    expect(searchQuery.startsWith('meaning of ')).toBe(true);
    expect(searchQuery.slice('meaning of '.length)).toHaveLength(200);
    expect(mapsQuery).toHaveLength(200);
  });

  it('encodes punctuation without leaking any surrounding text', () => {
    const tappedSnippet = 'Royal Regantris Trawangan (4*)';
    const url = googleMapsUrl(tappedSnippet);

    expect(decodeURIComponent(url)).toContain(tappedSnippet);
    expect(url).not.toContain('Guest Information');
    expect(url).not.toContain('Travel Itinerary');
  });
});
