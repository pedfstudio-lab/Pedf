import { describe, expect, it } from 'vitest';
import { googleLocationSearchUrl, googleMapsLocationUrl } from './locationLink';

describe('location links', () => {
  it('encodes a location in the exact Google Search URL', () => {
    expect(googleLocationSearchUrl('Mount Batur, Bali')).toBe(
      'https://www.google.com/search?q=Mount%20Batur%2C%20Bali',
    );
  });

  it('encodes a location in the exact universal Google Maps URL', () => {
    expect(googleMapsLocationUrl('Mount Batur, Bali')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Mount%20Batur%2C%20Bali',
    );
  });
});
