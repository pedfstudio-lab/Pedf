export const NOTO_DEVANAGARI = 'Noto Sans Devanagari';
export const NOTO_TAMIL = 'Noto Sans Tamil';

const FONT_DEFINITIONS = [
  {
    family: NOTO_DEVANAGARI,
    weight: '400',
    file: 'NotoSansDevanagari-Regular.woff2',
  },
  {
    family: NOTO_DEVANAGARI,
    weight: '700',
    file: 'NotoSansDevanagari-Bold.woff2',
  },
  {
    family: NOTO_TAMIL,
    weight: '400',
    file: 'NotoSansTamil-Regular.woff2',
  },
  {
    family: NOTO_TAMIL,
    weight: '700',
    file: 'NotoSansTamil-Bold.woff2',
  },
] as const;

let pending: Promise<void> | null = null;

/** Load and register the Indic shaping fonts once, then wait until they are usable. */
export function ensureIndicFonts(): Promise<void> {
  return (pending ??= loadAll());
}

async function loadAll(): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') {
    return;
  }

  await Promise.all(
    FONT_DEFINITIONS.map(async (definition) => {
      const face = new FontFace(
        definition.family,
        `url(${import.meta.env.BASE_URL}fonts/${definition.file})`,
        {
          weight: definition.weight,
          style: 'normal',
          display: 'swap',
        },
      );
      await face.load();
      document.fonts.add(face);
    }),
  );

  await document.fonts.ready;
}
