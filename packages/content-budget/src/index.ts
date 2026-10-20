import { TextDecoder, TextEncoder } from 'node:util';

export type BoundedText =
  | { kind: 'text'; text: string; truncated: boolean; sourceBytes: number }
  | { kind: 'unavailable'; reason: 'empty-content' | 'invalid-text' | 'input-too-large' | 'budget-too-small' };

export function boundFileText(text: string, maximumBytes: number): BoundedText {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024)
    throw new RangeError('Invalid file text budget');
  if (text.length > 1024 * 1024) return { kind: 'unavailable', reason: 'input-too-large' };
  if (!text.isWellFormed() || text.includes('\0')) return { kind: 'unavailable', reason: 'invalid-text' };
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength > 1024 * 1024) return { kind: 'unavailable', reason: 'input-too-large' };
  if (!text.trim()) return { kind: 'unavailable', reason: 'empty-content' };
  if (encoded.byteLength <= maximumBytes)
    return { kind: 'text', text, truncated: false, sourceBytes: encoded.byteLength };
  let end = maximumBytes;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) <= 0xbf) end--;
  const prefix = new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded.subarray(0, end));
  if (!prefix.trim()) return { kind: 'unavailable', reason: 'budget-too-small' };
  return { kind: 'text', text: prefix, truncated: true, sourceBytes: encoded.byteLength };
}
