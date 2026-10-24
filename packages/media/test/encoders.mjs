export function bigEndianTiff(width, height, rgb) {
  const entries = [
    [256, 3, 1, width],
    [257, 3, 1, height],
    [258, 3, 3, 134],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, 140],
    [277, 3, 1, 3],
    [278, 3, 1, height],
    [279, 4, 1, width * height * 3],
    [284, 3, 1, 1],
  ];
  const bytes = Buffer.alloc(140 + width * height * 3);
  bytes.write('MM', 0, 'latin1');
  bytes.writeUInt16BE(42, 2);
  bytes.writeUInt32BE(8, 4);
  bytes.writeUInt16BE(entries.length, 8);
  entries.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12;
    bytes.writeUInt16BE(tag, offset);
    bytes.writeUInt16BE(type, offset + 2);
    bytes.writeUInt32BE(count, offset + 4);
    if (type === 3 && count === 1) bytes.writeUInt16BE(value, offset + 8);
    else bytes.writeUInt32BE(value, offset + 8);
  });
  [8, 8, 8].forEach((bits, index) => bytes.writeUInt16BE(bits, 134 + index * 2));
  for (let pixel = 140; pixel < bytes.length; pixel += 3) bytes.set(rgb, pixel);
  return bytes;
}

export function bmp24(width, height, [red, green, blue]) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write('BM', 0, 'latin1');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) bytes.set([blue, green, red], 54 + y * stride + x * 3);
  }
  return bytes;
}

export function bmp8Palette(width, height, palette, indexes) {
  const stride = Math.ceil(width / 4) * 4;
  const pixelOffset = 54 + palette.length * 4;
  const bytes = Buffer.alloc(pixelOffset + stride * height);
  bytes.write('BM', 0, 'latin1');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(pixelOffset, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(-height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(8, 28);
  bytes.writeUInt32LE(palette.length, 46);
  palette.forEach(([red, green, blue], index) => bytes.set([blue, green, red, 0], 54 + index * 4));
  indexes.forEach((row, y) => bytes.set(row, pixelOffset + y * stride));
  return bytes;
}
