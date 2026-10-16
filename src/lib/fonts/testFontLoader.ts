// The production loader only fetches same-origin assets. Unit/real-PDF tests
// read those exact checked-in bytes, rather than silently using system fonts.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setFontByteLoader } from './twinFonts';
setFontByteLoader(async file => new Uint8Array(await readFile(resolve('public/fonts', file))));
