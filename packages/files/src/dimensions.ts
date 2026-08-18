/**
 * An image's pixel dimensions, read from its header.
 *
 * Read rather than decoded because the default policy refuses an oversized image, and decoding a
 * whole bitmap to learn a number that sits in the first few dozen bytes would make the refusal
 * cost more than the acceptance. Every format here states its size in a fixed-position header
 * field, so this stays O(1) in the image's size.
 *
 * Only the formats on the upload allowlist are covered. Anything else answers `null`, which
 * callers must treat as "unknown", never as "small enough".
 */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function matches(bytes: Uint8Array, offset: number, ascii: string): boolean {
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[offset + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

/** PNG states its size in the IHDR chunk, which the spec requires to come first. */
function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || !matches(bytes, 12, "IHDR")) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** GIF's logical screen descriptor follows the 6-byte version header, little-endian. */
function gifSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/**
 * JPEG has no fixed size field: the frame header can sit behind any amount of EXIF, so the marker
 * chain has to be walked. Only the SOF markers carry dimensions, and the three codes in that
 * numeric range that are not frame headers (DHT, JPG, DAC) must be skipped rather than read.
 */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Standalone markers carry no length field, so the walk cannot skip past them by length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * WebP is three formats behind one container, and each states its size differently: lossy hides
 * it behind the VP8 sync code, lossless packs two 14-bit fields across four bytes, and extended
 * stores a canvas size as two 24-bit values. A reader that handled only one would silently answer
 * `null` for the other two and let an oversized image through as "unknown".
 */
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30 || !matches(bytes, 8, "WEBP")) return null;
  if (matches(bytes, 12, "VP8X")) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (matches(bytes, 12, "VP8L")) {
    const packed = u32be(bytes, 21);
    // Little-endian 32-bit field read big-endian, so the bit order is reversed back here.
    const bits =
      ((packed >>> 24) & 0xff) |
      (((packed >>> 16) & 0xff) << 8) |
      (((packed >>> 8) & 0xff) << 16) |
      ((packed & 0xff) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (matches(bytes, 12, "VP8 ")) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return null;
}

/**
 * The pixel dimensions of these bytes, or `null` when the format is unreadable or malformed.
 *
 * `null` is not a pass. A caller enforcing a size limit has to decide what an unreadable header
 * means, and the safe answer is to refuse it.
 */
export function imageSize(bytes: Uint8Array, mediaType: string): ImageSize | null {
  const size = sizeFor(bytes, mediaType);
  if (size === null) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  return size;
}

function sizeFor(bytes: Uint8Array, mediaType: string): ImageSize | null {
  switch (mediaType) {
    case "image/png":
      return pngSize(bytes);
    case "image/gif":
      return gifSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return null;
  }
}
