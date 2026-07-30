import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ConstructedFace {
  readonly family: string;
  readonly source: string;
  readonly descriptors: FontFaceDescriptors | undefined;
  readonly instance: FontFaceStub;
}

class FontFaceStub {
  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors?: FontFaceDescriptors,
  ) {}

  async load(): Promise<this> {
    return this;
  }
}

function installBrowserFontStubs(ready: Promise<unknown> = Promise.resolve()) {
  const constructed: ConstructedFace[] = [];
  const loaded: FontFaceStub[] = [];
  const add = vi.fn();

  class TrackingFontFace extends FontFaceStub {
    constructor(family: string, source: string, descriptors?: FontFaceDescriptors) {
      super(family, source, descriptors);
      constructed.push({ family, source, descriptors, instance: this });
    }

    override async load(): Promise<this> {
      loaded.push(this);
      return this;
    }
  }

  vi.stubGlobal('FontFace', TrackingFontFace);
  vi.stubGlobal('document', { fonts: { add, ready } });

  return { add, constructed, loaded };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('ensureIndicFonts', () => {
  it('memoizes one load pass and returns the same promise', async () => {
    const stubs = installBrowserFontStubs();
    const { ensureIndicFonts } = await import('./notoFonts');

    const first = ensureIndicFonts();
    const second = ensureIndicFonts();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(stubs.constructed).toHaveLength(4);
    expect(stubs.loaded).toHaveLength(4);
    expect(stubs.add).toHaveBeenCalledTimes(4);
  });

  it('registers Devanagari and Tamil regular and bold faces', async () => {
    const stubs = installBrowserFontStubs();
    const { ensureIndicFonts, NOTO_DEVANAGARI, NOTO_TAMIL } = await import('./notoFonts');

    await ensureIndicFonts();

    expect(
      stubs.constructed.map(({ family, descriptors }) => ({
        family,
        weight: descriptors?.weight,
        style: descriptors?.style,
        display: descriptors?.display,
      })),
    ).toEqual([
      { family: NOTO_DEVANAGARI, weight: '400', style: 'normal', display: 'swap' },
      { family: NOTO_DEVANAGARI, weight: '700', style: 'normal', display: 'swap' },
      { family: NOTO_TAMIL, weight: '400', style: 'normal', display: 'swap' },
      { family: NOTO_TAMIL, weight: '700', style: 'normal', display: 'swap' },
    ]);

    expect(stubs.constructed.map(({ source }) => source)).toEqual([
      expect.stringMatching(/url\(.+fonts\/NotoSansDevanagari-Regular\.woff2\)/),
      expect.stringMatching(/url\(.+fonts\/NotoSansDevanagari-Bold\.woff2\)/),
      expect.stringMatching(/url\(.+fonts\/NotoSansTamil-Regular\.woff2\)/),
      expect.stringMatching(/url\(.+fonts\/NotoSansTamil-Bold\.woff2\)/),
    ]);
    expect(stubs.add.mock.calls.map(([face]) => face)).toEqual(
      stubs.constructed.map(({ instance }) => instance),
    );
  });

  it('does not resolve until document.fonts.ready resolves', async () => {
    let releaseReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const stubs = installBrowserFontStubs(ready);
    const { ensureIndicFonts } = await import('./notoFonts');
    let completed = false;

    const loading = ensureIndicFonts().then(() => {
      completed = true;
    });

    await vi.waitFor(() => expect(stubs.add).toHaveBeenCalledTimes(4));
    expect(completed).toBe(false);

    expect(releaseReady).toBeTypeOf('function');
    releaseReady?.();
    await loading;
    expect(completed).toBe(true);
  });

  it('resolves without touching browser APIs when they are unavailable', async () => {
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('FontFace', undefined);
    const { ensureIndicFonts } = await import('./notoFonts');

    await expect(ensureIndicFonts()).resolves.toBeUndefined();
  });
});
