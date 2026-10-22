import { crc32, inflateRawSync } from 'node:zlib';
import { KnowledgeParseError, parserLimits } from './contracts.js';

export function checkArchive(bytes: Buffer): Map<string, Buffer> {
  const parts = new Map<string, Buffer>();
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < minimum || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) malformed();
  const entries = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (entries === 65535 || size === 0xffffffff || start === 0xffffffff || entries > parserLimits.archiveEntries)
    limited();
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== entries || start + size !== end) malformed();
  let position = start;
  let expanded = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index += 1) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) malformed();
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const checksum = bytes.readUInt32LE(position + 16);
    const compressed = bytes.readUInt32LE(position + 20);
    const uncompressed = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const local = bytes.readUInt32LE(position + 42);
    if (flags & 1) throw new KnowledgeParseError('encrypted');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || local === 0xffffffff) limited();
    expanded += uncompressed;
    if (expanded > parserLimits.expandedBytes) limited();
    if (position + 46 + nameLength + extraLength + commentLength > end || local + 30 > start) malformed();
    const name = bytes.subarray(position + 46, position + 46 + nameLength);
    const partName = new TextDecoder('utf-8', { fatal: true }).decode(name);
    if (
      partName.startsWith('/') ||
      partName.includes('\\') ||
      partName.split('/').some(segment => segment === '.' || segment === '..')
    )
      malformed();
    const key = name.toString('hex');
    if (names.has(key)) malformed();
    names.add(key);
    if (
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      malformed();
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(local + 14) !== checksum ||
        bytes.readUInt32LE(local + 18) !== compressed ||
        bytes.readUInt32LE(local + 22) !== uncompressed)
    )
      malformed();
    const localNameLength = bytes.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (dataStart + compressed > start || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(name))
      malformed();
    const payload = bytes.subarray(dataStart, dataStart + compressed);
    if (method === 0) {
      if (compressed !== uncompressed || crc32(payload) !== checksum) malformed();
      parts.set(partName, payload);
    } else if (method === 8) {
      try {
        const actual = inflateRawSync(payload, {
          maxOutputLength: Math.min(uncompressed + 1, parserLimits.expandedBytes),
        });
        if (actual.length !== uncompressed || crc32(actual) !== checksum) malformed();
        parts.set(partName, actual);
      } catch (error) {
        if (error instanceof KnowledgeParseError) throw error;
        if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') limited();
        malformed();
      }
    } else {
      throw new KnowledgeParseError('unsupported');
    }
    position += 46 + nameLength + extraLength + commentLength;
  }
  if (position !== end) malformed();
  return parts;
}

function malformed(): never {
  throw new KnowledgeParseError('malformed');
}
function limited(): never {
  throw new KnowledgeParseError('resource-limited');
}
