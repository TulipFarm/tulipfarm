import { z } from 'zod';
import { uuidSchema, sourceDependenciesSchema, knowledgeSourceDependencySchema } from '@tulipfarm/access';
import { chunkSchema, knowledgeLimits } from '@tulipfarm/memory-core/document-contracts';

export { chunkSchema, knowledgeLimits };
export const providerCoverage = Object.freeze({
  conversation: {
    content: 'closed chat recap',
    permission: 'current chat readers and retained source dependencies',
    status: 'local',
  },
  note: { content: 'authored text', permission: 'current owner membership', status: 'local' },
  file: {
    content: 'explicit selected Files reference',
    permission: 'current Files ancestry and grants',
    status: 'local',
  },
  google: {
    content: 'selected Drive exports and Gmail',
    permission: 'Drive ACL and group proofs; Gmail owner only',
    status: 'adapter-required',
  },
  slack: {
    content: 'selected channels and conversations',
    permission: 'complete membership and guest/private scope',
    status: 'adapter-required',
  },
  github: {
    content: 'selected repository text, issues and discussions',
    permission: 'repository access and org/team membership',
    status: 'adapter-required',
  },
  confluence: {
    content: 'selected spaces and pages',
    permission: 'inherited space/page restrictions and groups',
    status: 'adapter-required',
  },
  jira: {
    content: 'selected issues and allowed comments',
    permission: 'project access, issue security, comment restrictions',
    status: 'adapter-required',
  },
});
const boundedText = z.string().min(1).max(2048);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceInput = z.strictObject({
  id: uuidSchema,
  provider: z.enum(['note', 'file', 'google', 'slack', 'github', 'confluence', 'jira', 'conversation']),
  accountNamespace: boundedText,
  selection: boundedText,
});
export const parserProfileSchema = z.strictObject({
  id: boundedText,
  engine: z.enum(['text', 'anydoc', 'provider']),
  version: boundedText,
  normalization: boundedText,
  ocr: z.literal('disabled'),
});
export const embeddingProfileSchema = z.strictObject({
  id: boundedText,
  model: z.literal('text-embedding-3-large'),
  deployment: boundedText,
  dimensions: z.union([z.literal(1536), z.literal(3072)]),
  tokenizer: boundedText,
  preparation: boundedText,
});
export const originalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file'),
    fileId: uuidSchema,
    sha256: hash,
    bytes: z.number().int().min(1).max(knowledgeLimits.originalBytes),
  }),
  z.strictObject({
    kind: z.literal('object'),
    key: uuidSchema,
    sha256: hash,
    bytes: z.number().int().min(1).max(knowledgeLimits.originalBytes),
  }),
]);
export const revisionInput = z.strictObject({
  id: uuidSchema,
  documentId: uuidSchema,
  sourceId: uuidSchema,
  nativeId: boundedText,
  expectedRevisionId: uuidSchema.nullable(),
  sourceRevision: boundedText,
  title: z.string().min(1).max(512),
  canonicalUrl: z.url().max(2048).nullable(),
  original: originalSchema,
  parserProfile: parserProfileSchema,
  sources: sourceDependenciesSchema.refine(value => Buffer.byteLength(JSON.stringify(value)) <= 65536).default([]),
});
export const lexicalInput = z
  .strictObject({
    id: uuidSchema,
    documentId: uuidSchema,
    revisionId: uuidSchema,
    markdown: z
      .string()
      .min(1)
      .refine(text => Buffer.byteLength(text) <= knowledgeLimits.normalizedBytes),
    pages: z.number().int().min(0).max(knowledgeLimits.pages),
    tokens: z.number().int().min(1).max(knowledgeLimits.tokens),
    chunks: z.array(chunkSchema).min(1).max(knowledgeLimits.chunksPerRevision),
  })
  .refine(value => value.chunks.reduce((sum, chunk) => sum + chunk.tokens, 0) <= knowledgeLimits.tokens);
export const proofInput = z
  .strictObject({
    id: uuidSchema,
    documentId: uuidSchema,
    accessEpoch: z.number().int().positive(),
    principal: boundedText,
    aclVersion: boundedText,
    membershipVersion: boundedText,
    aclCheckedAt: z.coerce.date(),
    membershipCheckedAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
  })
  .refine(
    proof =>
      proof.expiresAt.getTime() > Math.max(proof.aclCheckedAt.getTime(), proof.membershipCheckedAt.getTime()) &&
      proof.expiresAt.getTime() <=
        Math.min(proof.aclCheckedAt.getTime(), proof.membershipCheckedAt.getTime()) + knowledgeLimits.permissionAgeMs,
  );
export const citationSchema = knowledgeSourceDependencySchema.extend({
  ordinal: z
    .number()
    .int()
    .min(0)
    .max(knowledgeLimits.chunksPerRevision - 1),
});
export type KnowledgeCitation = z.infer<typeof citationSchema>;
export type EmbeddingProfile = z.infer<typeof embeddingProfileSchema>;
/** The connected provider account is no longer the one an automatic request was recorded for. */
export class KnowledgeAccountChanged extends Error {
  readonly code = 'account-changed';
  constructor() {
    super('Knowledge account changed');
  }
}
export class KnowledgeError extends Error {
  constructor(
    readonly code:
      | 'conflict'
      | 'quota'
      | 'superseded'
      | 'permission-expired'
      | 'adapter-required'
      | 'incomplete'
      | 'integrity',
  ) {
    super(`Knowledge ${code}`);
  }
}
