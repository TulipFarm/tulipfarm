import { z } from 'zod';
import { knowledgeLimits } from '../document-contracts.js';
import { KnowledgeParseError, metadataSchema, parseFailure, parserLimits } from './contracts.js';
import { extractDocument } from './convert.js';
import { readMedia } from './media.js';
import { mediaIdSchema, mediaLimits, mediaRefSchema } from './media-contracts.js';

export const workerRequestSchema = z.discriminatedUnion('mode', [
  metadataSchema.extend({ mode: z.literal('extract') }),
  metadataSchema.extend({
    mode: z.literal('media'),
    items: z
      .array(z.strictObject({ id: mediaIdSchema, kind: z.enum(['image', 'page']), ref: mediaRefSchema }))
      .min(1)
      .max(mediaLimits.batchItems),
  }),
]);

async function main(): Promise<void> {
  try {
    const raw: unknown = JSON.parse(process.argv[2] ?? 'null');
    const request = workerRequestSchema.parse(raw);
    let length = 0;
    const parts: Buffer[] = [];
    for await (const value of process.stdin) {
      const part = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += part.length;
      if (length > knowledgeLimits.originalBytes) throw new KnowledgeParseError('resource-limited');
      parts.push(part);
    }
    if (!length) throw new KnowledgeParseError('malformed');
    const input = {
      bytes: Buffer.concat(parts),
      filename: request.filename,
      mediaType: request.mediaType,
      rawTextFallback: request.rawTextFallback === true,
    };
    if (request.mode === 'media') {
      const { header, bytes } = await readMedia(input, request.items);
      // One JSON line, then the raw bytes of ready items in header order.
      await write(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ...bytes]));
      return;
    }
    const extraction = await extractDocument(input);
    const response = JSON.stringify({ kind: 'ready', extraction });
    if (Buffer.byteLength(response) > parserLimits.outputBytes) throw new KnowledgeParseError('resource-limited');
    await write(Buffer.from(response));
  } catch (error) {
    await write(Buffer.from(JSON.stringify({ kind: 'failed', failure: parseFailure(error) })));
  }
}

function write(bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => process.stdout.write(bytes, error => (error ? reject(error) : resolve())));
}

await main();
