export const SAVED_SIGNATURES_KEY = 'pedf.signatures';
export const MAX_SAVED_SIGNATURES = 5;

export interface SavedSignature {
  id: string;
  label: string;
  pngDataUrl: string;
  createdAt: number;
}

function storage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

function valid(value: unknown): value is SavedSignature {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SavedSignature>;
  return typeof entry.id === 'string' && typeof entry.label === 'string'
    && typeof entry.pngDataUrl === 'string' && entry.pngDataUrl.startsWith('data:image/png;base64,')
    && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt);
}

export function listSaved(): SavedSignature[] {
  try {
    const raw = storage()?.getItem(SAVED_SIGNATURES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(valid).sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_SAVED_SIGNATURES)
      : [];
  } catch { return []; }
}

function identifier(): string {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fallback */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function saveSignature(signature: Omit<SavedSignature, 'id' | 'createdAt'> & Partial<Pick<SavedSignature, 'id' | 'createdAt'>>): SavedSignature | undefined {
  const target = storage();
  if (!target) return undefined;
  const entry: SavedSignature = {
    id: signature.id ?? identifier(),
    label: signature.label.trim() || 'My signature',
    pngDataUrl: signature.pngDataUrl,
    createdAt: signature.createdAt ?? Date.now(),
  };
  try {
    const next = [entry, ...listSaved().filter((saved) => saved.id !== entry.id)]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_SAVED_SIGNATURES);
    target.setItem(SAVED_SIGNATURES_KEY, JSON.stringify(next));
    return entry;
  } catch { return undefined; }
}

export function deleteSaved(id: string): void {
  try {
    const target = storage();
    if (!target) return;
    target.setItem(SAVED_SIGNATURES_KEY, JSON.stringify(listSaved().filter((entry) => entry.id !== id)));
  } catch { /* Storage can be unavailable in private or locked-down browsing contexts. */ }
}
