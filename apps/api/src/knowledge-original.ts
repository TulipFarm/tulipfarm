import type { FastifyReply } from 'fastify';

export function sendKnowledgeOriginal(reply: FastifyReply, result: { filename: string; bytes: Uint8Array }) {
  const filename = encodeURIComponent(result.filename).replaceAll("'", '%27');
  return reply
    .header('X-Content-Type-Options', 'nosniff')
    .header('Access-Control-Expose-Headers', 'Content-Disposition')
    .header('Content-Disposition', `attachment; filename="document"; filename*=UTF-8''${filename}`)
    .type('application/octet-stream')
    .send(Buffer.from(result.bytes));
}
