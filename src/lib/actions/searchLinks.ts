const MAX_SNIPPET_LENGTH = 200;

function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_LENGTH);
}

export function googleSearchUrl(text: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`meaning of ${snippet(text)}`)}`;
}

export function googleMapsUrl(text: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(snippet(text))}`;
}
