/** Build a Google Search URL without sending any additional data to the AI provider. */
export function googleLocationSearchUrl(location: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(location)}`;
}

/** Build the universal Google Maps search URL used by mobile and desktop browsers. */
export function googleMapsLocationUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}
