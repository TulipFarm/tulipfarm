import { z } from 'zod';

export const knowledgeLimits = Object.freeze({
  documents: 50_000,
  revisionsPerDocument: 32,
  originalBytes: 10 * 1024 * 1024,
  normalizedBytes: 10 * 1024 * 1024,
  retainedBytes: 5 * 1024 * 1024 * 1024,
  pages: 500,
  tokens: 250_000,
  chunksPerRevision: 4096,
  retainedChunks: 750_000,
  chunkBytes: 32_768,
  chunkTokens: 8192,
  publicationsPerRevision: 8,
  attemptsPerRevision: 8,
  permissionAgeMs: 300_000,
  retentionDays: 30,
});

export const chunkSchema = z.strictObject({
  heading: z.string().max(2048),
  text: z
    .string()
    .min(1)
    .refine(text => Buffer.byteLength(text) <= knowledgeLimits.chunkBytes),
  tokens: z.number().int().min(1).max(knowledgeLimits.chunkTokens),
  offset: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('passage') }),
    z.strictObject({ kind: z.literal('page'), page: z.number().int().min(1).max(knowledgeLimits.pages) }),
    z.strictObject({ kind: z.literal('slide'), slide: z.number().int().min(1).max(knowledgeLimits.pages) }),
    z.strictObject({
      kind: z.literal('sheet'),
      sheet: z.number().int().min(1).max(knowledgeLimits.pages),
      name: z.string().max(256),
    }),
  ]),
});
