import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { matchFont, normalizeFontName, registerSourceFont, calibrateSourceFont, sourceFontIdentity, canUseSourceWord, sourceFontWidth, pageFontTracking } from './fontMatch';
import { sfntMetrics } from './sfnt';
import { fallbackWordRanges } from './wordFonts';
import type { TextStyle } from '@/lib/export/types';
const style = (fontName: string): TextStyle => ({ fontName, fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } });

describe('Task 78 font identity and local assets', () => {
  it.each(['PaidSans','Lato','Calibri'])('measures page tightening separately from nominal font matching: %s',name=>{
    registerSourceFont(`tracking-${name}`,{name,type:'TrueType'},new Map([['a',500],['b',500],['c',500],['d',500]]));
    const s={...style(name),fontRef:`tracking-${name}`,fontIdentity:name};
    const runs=['abcd','abdc','acbd'].map(text=>({text,rect:{w:21.6},style:s}));
    expect(pageFontTracking(runs).get(s.fontRef)).toBeCloseTo(-0.05);
    expect(sourceFontWidth('abcd',s)).toBe(24);
    expect(pageFontTracking(runs.slice(0,1)).size).toBe(0);
    expect(pageFontTracking(runs.map(r=>({...r,rect:{w:24}}))).size).toBe(0);
    expect(pageFontTracking(runs.map(r=>({...r,metrics:{horizontalScale:0.8}}))).size).toBe(0);
    expect(pageFontTracking(runs.map(r=>({...r,metrics:{matrix:[9.6,0,0,12,0,0]}}))).size).toBe(0);
  });
  it('normalizes subset and PostScript suffixes', () => expect(normalizeFontName('ABCDEF+Arial-BoldMT')).toBe('arialbold'));
  it.each([
    ['Calibri', 'Carlito'], ['Arial', 'LiberationSans'], ['TimesNewRomanPSMT', 'LiberationSerif'], ['CourierNewPSMT','LiberationMono'],
    ['Lato-Regular','Lato'], ['OpenSans-Bold','OpenSans'], ['IBMPlexSans','IBMPlexSans'], ['LeagueSpartan-Bold','LeagueSpartan'],
    ['NotoSans','NotoSans'], ['SourceSansPro','SourceSansPro'], ['BricolageGrotesque','BricolageGrotesque'], ['Allura','Allura'],
  ])('maps %s to the licensed %s', (name, family) => expect(matchFont(style(name)).family).toBe(family));
  it.each(['Arial Black','HelveticaNowText','Aptos Narrow','Tahoma','Organic','Zuume Rough','TAN Jambore','NotoSansCJKsc','NotoSansDevanagari'])('does not pretend %s has an exact free twin', name => expect(matchFont(style(name)).exact).toBe(false));
  it('does not add the dropped Caladea', () => expect(matchFont(style('Cambria')).family).toBe('LiberationSerif'));
  it('finds the actual family behind a CID name', async () => {
    const data = new Uint8Array(await readFile('public/fonts/carlito/Carlito-Regular.ttf'));
    registerSourceFont('cid-test', { name: 'CIDFont+F3', type: 'CIDFontType2', data });
    expect(sourceFontIdentity('cid-test').fontIdentity).toBe('Carlito');
    expect(matchFont({ ...style('sans-serif'), fontRef: 'cid-test' }).family).toBe('Carlito');
  });
  it('uses median nominal-letter ratio, independent of tracking or word spaces', async () => {
    const data = new Uint8Array(await readFile('public/fonts/liberation/LiberationSans-Regular.ttf'));
    const metrics = sfntMetrics(data), observed = new Map(['A','B','C','D','E'].map((letter, index) => [letter, metrics.width(letter)! * 1000 * (index === 4 ? 1.8 : 0.8)]));
    registerSourceFont('width-test', { name: 'PaidFont', type: 'Type3', isType3Font: true, fontMatrix: [0.001,0,0,0.001,0,0] }, observed);
    calibrateSourceFont('width-test', data);
    expect(sourceFontIdentity('width-test').fontWidthScale).toBeCloseTo(0.8, 10);
    expect(sourceFontWidth('AB', { ...style('PaidFont'), fontRef: 'width-test' })).toBeGreaterThan(0);
  });
  it('switches an entire word across rich-piece boundaries when the subset lacks Q', () => {
    registerSourceFont('tiny-subset', { name: 'Calibri', type: 'TrueType' }, new Map([['a',500],['b',500]]));
    const s = { ...style('Calibri'), fontRef: 'tiny-subset' };
    expect(canUseSourceWord('ab', s)).toBe(true); expect(canUseSourceWord('abQ', s)).toBe(false);
    expect(fallbackWordRanges('abQ ab', [{ start:0, text:'ab', style:s },{ start:2,text:'Q ab',style:s }], canUseSourceWord)).toEqual([{start:0,end:3}]);
  });
  it('ships every selected regular/B/I asset, plus its OFL notice', async () => {
    for (const name of ['Calibri','Arial','Times New Roman','Courier New','Lato','Open Sans','IBM Plex Sans','League Spartan','Noto Sans','Source Sans Pro','Bricolage Grotesque','Allura']) {
      for (const bold of [false,true]) for (const italic of [false,true]) {
        const match = matchFont({ ...style(name), bold, italic });
        const data = new Uint8Array(await readFile(`public/fonts/${match.file}`));
        expect(sfntMetrics(data).width('Q')).toBeGreaterThan(0);
        expect(await readFile(`public/fonts/${match.file.split('/')[0]}/OFL.txt`, 'utf8')).toMatch(/OPEN FONT LICENSE Version 1.1/);
      }
    }
  });
});
