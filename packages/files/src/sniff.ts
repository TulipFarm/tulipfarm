/**
 * What a file's bytes actually are, read from the bytes.
 *
 * A client's `Content-Type` and a filename's extension are both attacker-controlled. Sniffing is
 * the only claim about a file's type that is worth storing and the only one worth serving back,
 * so every upload resolves its type here and the claimed value is kept only as a signal.
 *
 * This is a deliberately small sniffer, covering exactly the allowlist. A general-purpose one
 * would recognise formats we refuse anyway, which is surface without a reader.
 */

interface Signature {
  readonly mediaType: string;
  readonly bytes: readonly number[];
  readonly offset?: number;
}

const SIGNATURES: readonly Signature[] = [
  { mediaType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { mediaType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { mediaType: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/**
 * How many leading bytes {@link resolveMediaType} needs. Callers buffer at least this much.
 *
 * The binary signatures need 12; the text check wants a wider sample, because a handful of bytes
 * of an unrecognised binary can easily decode as clean UTF-8 by chance.
 */
export const SNIFF_BYTES = 512;

function startsWith(bytes: Uint8Array, signature: Signature): boolean {
  const offset = signature.offset ?? 0;
  if (bytes.length < offset + signature.bytes.length) return false;
  return signature.bytes.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * WebP is RIFF-framed, so its first four bytes say only "some RIFF container". The format lives
 * at offset 8, past a length field, which is why it cannot be a plain prefix signature.
 */
function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  return (
    riff.every((byte, index) => bytes[index] === byte) &&
    webp.every((byte, index) => bytes[8 + index] === byte)
  );
}

/**
 * The type of these bytes, or `null` when they match no signature we accept.
 *
 * Text formats have no magic bytes, so they cannot be sniffed and are not resolved here. A caller
 * that wants to accept text has to decide that from the claimed type, having first established
 * that the bytes match no binary signature — otherwise a PNG claiming `text/plain` would pass.
 */
export function sniffMediaType(bytes: Uint8Array): string | null {
  if (isWebp(bytes)) return "image/webp";
  for (const signature of SIGNATURES) {
    if (startsWith(bytes, signature)) return signature.mediaType;
  }
  return null;
}

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

const OOXML_ENTRY_BY_MEDIA_TYPE = new Map<string, string>([
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word/"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xl/"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "ppt/"],
]);

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03;
}

function zipContainsEntry(bytes: Uint8Array, prefix: string): boolean {
  if (!isZip(bytes)) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 0; offset + 30 <= bytes.length; offset += 1) {
    if (
      bytes[offset] !== 0x50 ||
      bytes[offset + 1] !== 0x4b ||
      bytes[offset + 2] !== 0x03 ||
      bytes[offset + 3] !== 0x04
    ) {
      continue;
    }
    const nameLength = (bytes[offset + 27] ?? 0) * 256 + (bytes[offset + 26] ?? 0);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) continue;
    try {
      if (decoder.decode(bytes.subarray(nameStart, nameEnd)).startsWith(prefix)) return true;
    } catch {}
  }
  return false;
}

/**
 * Resolves the type to store and serve, given what the bytes say and what the client claimed.
 *
 * Binary formats are decided by their signature and the claim is ignored. Text is the one case
 * where the claim gets a say, because plain text has no signature — and it gets that say only
 * after the bytes have failed to match any binary signature and have been shown to decode as
 * UTF-8, so a PNG cannot reach the text branch by claiming to be a CSV.
 */
export function resolveMediaType(bytes: Uint8Array, claimed: string): string | null {
  const sniffed = sniffMediaType(bytes);
  if (sniffed !== null) return sniffed;
  const officeEntry = OOXML_ENTRY_BY_MEDIA_TYPE.get(claimed);
  if (officeEntry && zipContainsEntry(bytes, officeEntry)) return claimed;
  if (TEXT_TYPES.has(claimed) && looksLikeText(bytes)) return claimed;
  return null;
}

/**
 * Whether the leading bytes decode as UTF-8 text with no control characters.
 *
 * A NUL or a stray control byte is what separates a truncated binary from a text file, and it is
 * the check that stops an unrecognised binary format from being stored as `text/plain`.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 512);
  let decoded: string;
  try {
    // Streaming mode holds back a trailing incomplete sequence rather than throwing on it, so a
    // sample that cuts a valid file mid-codepoint is not mistaken for a binary.
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
  } catch {
    // The only thing a decode failure can mean here is "these bytes are not UTF-8 text", which is
    // precisely the answer this function exists to give. There is nothing else to report.
    return false;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control bytes is the point.
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded);
}
