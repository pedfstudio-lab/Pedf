/** Remove [Page N] citation markers for speech; the on-screen text keeps them. */
export function stripPageMarkers(text: string): string {
  return text.replace(/\[Page[^\]]*\]/gi, '').replace(/\s{2,}/g, ' ').trim();
}
