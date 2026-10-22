import type { ContextMessage } from '../ports/summarizer.ts';

export function transcriptSlices(text: string, bytes: number) {
  const parts: string[] = [];
  let part = '';
  let size = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character);
    if (size + length > bytes && part) {
      parts.push(part);
      part = '';
      size = 0;
    }
    part += character;
    size += length;
  }
  if (part || !parts.length) parts.push(part);
  return parts;
}

/** Transcript chunks within a byte budget. Oversized messages split into numbered slices instead of being dropped. */
export function transcriptChunks(messages: readonly ContextMessage[], budget: number): string[] {
  const chunks: string[] = [];
  let current = '';
  const push = (entry: string) => {
    if (current && Buffer.byteLength(current) + Buffer.byteLength(entry) > budget) {
      chunks.push(current);
      current = '';
    }
    current += entry;
  };
  for (const message of messages) {
    const body = transcriptSlices(message.text, Math.max(1024, budget - 256));
    body.forEach((text, index) =>
      push(
        `<message id="${message.id}" role="${message.role === 'user' ? 'requester' : 'assistant'}"${body.length > 1 ? ` part="${index + 1}/${body.length}"` : ''}>\n${text}\n</message>\n`,
      ),
    );
  }
  if (current) chunks.push(current);
  return chunks;
}
