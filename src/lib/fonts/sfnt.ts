/** Small, bounded reader for the name/cmap/hmtx tables; no fontkit on page load. */
export function sfntMetrics(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const table = (tag: string) => {
    if (data.length < 12) return 0;
    for (let i = 0; i < view.getUint16(4) && 28 + 16 * i <= data.length; i++) {
      const p = 12 + 16 * i;
      if (String.fromCharCode(...data.subarray(p, p + 4)) === tag) {
        const start = view.getUint32(p + 8), length = view.getUint32(p + 12);
        return start + length <= data.length ? start : 0;
      }
    }
    return 0;
  };
  const names: { name: string; rank: number; id: number }[] = [];
  const nt = table('name');
  if (nt && nt + 6 <= data.length) for (let i = 0; i < view.getUint16(nt + 2); i++) {
    const p = nt + 6 + i * 12; if (p + 12 > data.length) break;
    const platform = view.getUint16(p), id = view.getUint16(p + 6);
    if (![1, 5, 16].includes(id)) continue;
    const start = nt + view.getUint16(nt + 4) + view.getUint16(p + 10), length = view.getUint16(p + 8);
    if (start + length > data.length) continue;
    let name = '';
    if (platform === 0 || platform === 3) for (let j = start; j + 1 < start + length; j += 2) name += String.fromCharCode(view.getUint16(j));
    else if (platform === 1) name = String.fromCharCode(...data.subarray(start, start + length));
    if (name) names.push({ name, rank: (id === 16 ? 10 : 0) + (platform === 3 ? 1 : 0), id });
  }
  const cmap = table('cmap'), head = table('head'), hhea = table('hhea'), hmtx = table('hmtx');
  const em = head && head + 20 <= data.length ? view.getUint16(head + 18) : 0;
  const count = hhea && hhea + 36 <= data.length ? view.getUint16(hhea + 34) : 0;
  const maps: number[] = [];
  if (cmap && cmap + 4 <= data.length) for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    const p = cmap + 4 + i * 8; if (p + 8 > data.length) break;
    const sub = cmap + view.getUint32(p + 4);
    if (sub + 16 <= data.length && [4, 12].includes(view.getUint16(sub))) maps.push(sub);
  }
  maps.sort((a, b) => view.getUint16(b) - view.getUint16(a));
  const glyphId = (cp: number) => {
    for (const sub of maps) {
      if (view.getUint16(sub) === 12) {
        const n = view.getUint32(sub + 12);
        for (let i = 0; i < n && sub + 28 + i * 12 <= data.length; i++) {
          const p = sub + 16 + i * 12, start = view.getUint32(p), end = view.getUint32(p + 4);
          if (cp >= start && cp <= end) return view.getUint32(p + 8) + cp - start;
        }
      } else if (cp <= 0xffff) {
        const n = view.getUint16(sub + 6) / 2;
        for (let i = 0; i < n; i++) {
          const end = sub + 14 + i * 2, start = sub + 16 + n * 2 + i * 2;
          const delta = sub + 16 + n * 4 + i * 2, range = sub + 16 + n * 6 + i * 2;
          if (range + 2 > data.length) break;
          if (cp < view.getUint16(start) || cp > view.getUint16(end)) continue;
          const offset = view.getUint16(range), address = range + offset + 2 * (cp - view.getUint16(start));
          const id = offset ? (address + 2 <= data.length ? view.getUint16(address) : 0) : cp;
          return id || !offset ? (id + view.getInt16(delta)) & 0xffff : 0;
        }
      }
    }
    return 0;
  };
  return {
    family: names.filter(value=>value.id!==5).sort((a, b) => b.rank - a.rank)[0]?.name,
    version: names.find(value=>value.id===5)?.name,
    width(character: string): number | undefined {
      if (!em || !count || !hmtx) return undefined;
      const glyph = glyphId(character.codePointAt(0) ?? 0); if (!glyph) return undefined;
      const p = hmtx + Math.min(glyph, count - 1) * 4;
      return p + 2 <= data.length ? view.getUint16(p) / em : undefined;
    },
  };
}
