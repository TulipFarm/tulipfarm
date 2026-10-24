type Sniffed = { type: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'svg' | 'other'; width?: number; height?: number };

/** Format and declared dimensions, read from headers before any pixels are decoded. */
export function sniffImage(bytes: Buffer): Sniffed {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR')
    return { type: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && bytes.toString('latin1', 0, 4).startsWith('GIF8'))
    return { type: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8X')
      return { type: 'webp', width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ')
      return { type: 'webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    return { type: 'webp' };
  }
  if (bytes.length >= 26 && bytes.toString('latin1', 0, 2) === 'BM')
    return { type: 'bmp', width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return { type: 'jpeg' };
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { type: 'jpeg', height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
    return { type: 'jpeg' };
  }
  const head = bytes
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (head.startsWith('<') && /<svg[\s>]/i.test(head)) return { type: 'svg' };
  return { type: 'other' };
}
