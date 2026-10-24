export type MediaFamily = 'image' | 'pdf' | 'archive' | 'office' | 'audio' | 'video';

const mediaFamilies = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'image/avif': 'image',
  'image/tiff': 'image',
  'image/bmp': 'image',
  'image/svg+xml': 'image',
  'application/pdf': 'pdf',
  'application/zip': 'archive',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'office',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'office',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'office',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
  'audio/flac': 'audio',
  'audio/mp4': 'audio',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'video/x-matroska': 'video',
  'video/x-msvideo': 'video',
} as const satisfies Record<string, MediaFamily>;

export type MediaType = keyof typeof mediaFamilies;

export type SniffedMedia = { mediaType: MediaType; family: MediaFamily };

const prefixes: ReadonlyArray<readonly [string | readonly number[], MediaType]> = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  ['GIF87a', 'image/gif'],
  ['GIF89a', 'image/gif'],
  [[0x49, 0x49, 0x2a, 0x00], 'image/tiff'],
  [[0x4d, 0x4d, 0x00, 0x2a], 'image/tiff'],
  ['%PDF-', 'application/pdf'],
  ['fLaC', 'audio/flac'],
  ['OggS', 'audio/ogg'],
  ['ID3', 'audio/mpeg'],
];

const riffForms: Record<string, MediaType> = { WEBP: 'image/webp', WAVE: 'audio/wav', 'AVI ': 'video/x-msvideo' };

const isoBrands: Record<string, MediaType> = {
  heic: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  heim: 'image/heif',
  heis: 'image/heif',
  mif1: 'image/heif',
  msf1: 'image/heif',
  avif: 'image/avif',
  avis: 'image/avif',
  'M4A ': 'audio/mp4',
  isom: 'video/mp4',
  iso2: 'video/mp4',
  mp41: 'video/mp4',
  mp42: 'video/mp4',
  avc1: 'video/mp4',
  'qt  ': 'video/quicktime',
};

const officeFolders: Record<string, MediaType> = {
  'word/': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xl/': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt/': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const bmpInfoHeaderSizes = new Set([12, 40, 52, 56, 64, 108, 124]);

export function sniffMediaType(bytes: Uint8Array): SniffedMedia | null {
  const mediaType = detect(bytes);
  return mediaType ? { mediaType, family: mediaFamilies[mediaType] } : null;
}

function detect(bytes: Uint8Array): MediaType | undefined {
  for (const [prefix, mediaType] of prefixes) {
    if (startsWith(bytes, prefix)) return mediaType;
  }
  if (startsWith(bytes, 'RIFF')) return riffForms[ascii(bytes, 8, 12)];
  if (ascii(bytes, 4, 8) === 'ftyp') return isoMediaType(bytes);
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(bytes, 0, 64).includes('webm') ? 'video/webm' : 'video/x-matroska';
  }
  if (startsWith(bytes, 'PK\x03\x04') || startsWith(bytes, 'PK\x05\x06')) return zipMediaType(bytes);
  if (isBmp(bytes)) return 'image/bmp';
  if (isMpegFrame(bytes)) return 'audio/mpeg';
  if (isSvg(bytes)) return 'image/svg+xml';
  return undefined;
}

function isoMediaType(bytes: Uint8Array): MediaType | undefined {
  const boxEnd = Math.min(bytes.length, readUint32(bytes, 0));
  const major = isoBrands[ascii(bytes, 8, 12)];
  if (major) return major;
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    const compatible = isoBrands[ascii(bytes, offset, offset + 4)];
    if (compatible) return compatible;
  }
  return undefined;
}

// Entries may use data descriptors, so sizes in local headers can be zero; scan for every header signature instead of walking.
function zipMediaType(bytes: Uint8Array): MediaType {
  const headers = [
    { signature: [0x50, 0x4b, 0x03, 0x04], nameLength: 26, name: 30 },
    { signature: [0x50, 0x4b, 0x01, 0x02], nameLength: 28, name: 46 },
  ];
  for (let offset = 0; offset + 30 <= bytes.length; offset++) {
    if (bytes[offset] !== 0x50) continue;
    for (const header of headers) {
      if (!startsWith(bytes.subarray(offset), header.signature)) continue;
      const length = bytes[offset + header.nameLength]! | (bytes[offset + header.nameLength + 1]! << 8);
      const name = ascii(bytes, offset + header.name, offset + header.name + length);
      for (const [folder, mediaType] of Object.entries(officeFolders)) {
        if (name.startsWith(folder)) return mediaType;
      }
    }
  }
  return 'application/zip';
}

function isBmp(bytes: Uint8Array): boolean {
  return startsWith(bytes, 'BM') && bytes.length >= 18 && bmpInfoHeaderSizes.has(readUint32LE(bytes, 14));
}

function isMpegFrame(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[0] !== 0xff) return false;
  const second = bytes[1]!;
  const sync = (second & 0xe0) === 0xe0;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  return sync && version !== 0b01 && layer !== 0b00;
}

function isSvg(bytes: Uint8Array): boolean {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096));
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  for (;;) {
    text = text.trimStart();
    if (text.startsWith('<?')) text = after(text, '?>');
    else if (text.startsWith('<!--')) text = after(text, '-->');
    else if (text.startsWith('<!DOCTYPE')) text = after(text, text.includes('[') ? ']>' : '>');
    else return /^<svg[\s>/]/.test(text);
  }
}

function after(text: string, terminator: string): string {
  const index = text.indexOf(terminator);
  return index === -1 ? '' : text.slice(index + terminator.length);
}

function startsWith(bytes: Uint8Array, prefix: string | readonly number[]): boolean {
  const expected = typeof prefix === 'string' ? Array.from(prefix, char => char.charCodeAt(0)) : prefix;
  return bytes.length >= expected.length && expected.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes.length < offset + 4 ? 0 : new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}
