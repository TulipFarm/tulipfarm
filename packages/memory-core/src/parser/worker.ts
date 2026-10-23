import { knowledgeLimits } from '../document-contracts.js';
import { KnowledgeParseError, metadataSchema, parseFailure, parserLimits } from './contracts.js';
import { convertDocument } from './convert.js';

async function main(): Promise<void> {
  try {
    const raw: unknown = JSON.parse(process.argv[2] ?? 'null');
    const metadata = metadataSchema.parse(raw);
    let length = 0;
    const parts: Buffer[] = [];
    for await (const value of process.stdin) {
      const part = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += part.length;
      if (length > knowledgeLimits.originalBytes) throw new KnowledgeParseError('resource-limited');
      parts.push(part);
    }
    if (!length) throw new KnowledgeParseError('malformed');
    const result = await convertDocument({
      bytes: Buffer.concat(parts),
      filename: metadata.filename,
      mediaType: metadata.mediaType,
      rawTextFallback: metadata.rawTextFallback === true,
    });
    const response = JSON.stringify({ kind: 'ready', result });
    if (Buffer.byteLength(response) > parserLimits.outputBytes) throw new KnowledgeParseError('resource-limited');
    process.stdout.write(response);
  } catch (error) {
    process.stdout.write(JSON.stringify({ kind: 'failed', failure: parseFailure(error) }));
  }
}

await main();
