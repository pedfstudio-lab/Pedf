import { describe,expect,it } from 'vitest';
import { isArrowBullet,normalizeSymbolBulletPrefix } from './symbolBullets';
import { startsWithBulletMarker } from './textUnits';
import { formatBulletEditorText,parseBulletEditorItems } from './bulletList';
import { listSeedText } from '@/lib/edit/paragraphSeed';
describe('the measured Wingdings arrow only',()=>{
  it('recognizes the source code and real character without adding speculative mappings',()=>{
    expect(isArrowBullet('\uF0D8')).toBe(true);expect(isArrowBullet('➢')).toBe(true);
    for(const code of ['\uF076','\uF0A7','\uF0FC'])expect(isArrowBullet(code)).toBe(false);
    expect(startsWithBulletMarker('➢ Item')).toBe(true);
    expect(normalizeSymbolBulletPrefix('  \uF0D8 Item')).toBe('  ➢ Item');
    expect(normalizeSymbolBulletPrefix('Text \uF0D8 inside')).toBe('Text \uF0D8 inside');
    const block={pageIndex:0,text:'\uF0D8 Only item',lines:[],rect:{x:0,y:0,w:100,h:12},topBaselineY:0,lineHeightPt:14,
      style:{fontName:'Helvetica',fontSizePt:12,bold:false,italic:false,color:{r:0,g:0,b:0}}};
    expect(listSeedText(block)).toBe('➢ Only item');expect(block.text).toBe('\uF0D8 Only item');
  });
  it('shows and parses real per-item symbols and copies the last for a new item',()=>{
    expect(formatBulletEditorText(['one','two','three'],['•','➢'])).toBe('• one\n➢ two\n➢ three');
    expect(parseBulletEditorItems('• one\n➢ two\n➢ three')).toEqual(['one','two','three']);
  });
});
