/**
 * fontkit 1.1.1 chooses short loca for small subsets but rounds odd offsets
 * down. Carlito uses legal odd byte offsets in its long-loca source. Align
 * glyph records before subsetting, preserving every outline/advance byte.
 * This is an in-memory export copy; shipped original fonts are not modified.
 */
export function subsetSafeSfnt(input: Uint8Array): Uint8Array {
  if (input.length < 12) return input;
  const source = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const count = source.getUint16(4), tables = new Map<string, Uint8Array>();
  if (12 + count * 16 > input.length) return input;
  for (let i = 0; i < count; i++) {
    const start = 12 + i * 16, tag = String.fromCharCode(...input.subarray(start, start + 4));
    const offset = source.getUint32(start + 8), length = source.getUint32(start + 12);
    if (offset + length > input.length) return input;
    tables.set(tag, input.subarray(offset, offset + length));
  }
  const head = tables.get('head'), loca = tables.get('loca'), glyf = tables.get('glyf'), maxp = tables.get('maxp');
  if (!head || head.length < 54 || !loca || !glyf || !maxp || maxp.length < 6) return input;
  if (new DataView(head.buffer, head.byteOffset, head.byteLength).getInt16(50) !== 1) return input;
  const glyphCount = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
  if (loca.length < (glyphCount + 1) * 4) return input;
  const positions = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
  const offsets = Array.from({ length: glyphCount + 1 }, (_, i) => positions.getUint32(i * 4));
  if (!offsets.some(offset => offset % 2)) return input;
  if (offsets.some((offset, i) => offset > glyf.length || (i > 0 && offset < offsets[i - 1]!))) return input;
  const align4 = (size: number) => Math.ceil(size / 4) * 4;
  const alignedLoca = new Uint8Array((glyphCount + 1) * 4), targetLoca = new DataView(alignedLoca.buffer);
  let length = 0;
  for (let i = 0; i < glyphCount; i++) { targetLoca.setUint32(i * 4, length); length += align4(offsets[i + 1]! - offsets[i]!); }
  targetLoca.setUint32(glyphCount * 4, length);
  const alignedGlyf = new Uint8Array(length);
  for (let i = 0; i < glyphCount; i++) alignedGlyf.set(glyf.subarray(offsets[i], offsets[i + 1]), targetLoca.getUint32(i * 4));
  const newHead = head.slice(); new DataView(newHead.buffer).setUint32(8, 0);
  tables.set('head', newHead); tables.set('glyf', alignedGlyf); tables.set('loca', alignedLoca);
  tables.delete('DSIG'); // Repacked container cannot retain a binary signature.
  const entries = [...tables].sort(([a], [b]) => a.localeCompare(b));
  const directoryLength = 12 + entries.length * 16;
  const output = new Uint8Array(directoryLength + entries.reduce((sum, [, bytes]) => sum + align4(bytes.length), 0));
  const target = new DataView(output.buffer);
  output.set(input.subarray(0, 4)); target.setUint16(4, entries.length);
  const power = Math.floor(Math.log2(entries.length));
  target.setUint16(6, 16 * 2 ** power); target.setUint16(8, power); target.setUint16(10, entries.length * 16 - 16 * 2 ** power);
  const checksum = (bytes: Uint8Array) => {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) sum = (sum + ((bytes[i]! << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0;
    return sum;
  };
  let offset = directoryLength, headOffset = 0;
  entries.forEach(([tag, bytes], i) => {
    const record = 12 + i * 16;
    for (let j = 0; j < 4; j++) output[record + j] = tag.charCodeAt(j);
    target.setUint32(record + 4, checksum(bytes)); target.setUint32(record + 8, offset); target.setUint32(record + 12, bytes.length);
    output.set(bytes, offset); if (tag === 'head') headOffset = offset;
    offset += align4(bytes.length);
  });
  target.setUint32(headOffset + 8, (0xB1B0AFBA - checksum(output)) >>> 0);
  return output;
}
