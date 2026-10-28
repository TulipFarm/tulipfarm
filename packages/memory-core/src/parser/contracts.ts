import { z } from 'zod';
import { chunkSchema, knowledgeLimits } from '../document-contracts.js';
import { coverageGapSchema } from './media-contracts.js';

export const parserLimits = Object.freeze({
  timeoutMs: 30_000,
  memoryBytes: 512 * 1024 * 1024,
  dataKiB: 768 * 1024,
  outputBytes: 32 * 1024 * 1024,
  diagnosticBytes: 16 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  archiveEntries: 10_000,
  concurrency: 2,
  niceness: 19,
  targetTokens: 800,
  overlapTokens: 100,
});

export const failureSchema = z.enum(['unsupported', 'encrypted', 'malformed', 'resource-limited', 'ocr-required']);
export type KnowledgeParseFailure = z.infer<typeof failureSchema>;

export const parseReasonSchema = z.enum([
  'content-limit',
  'document-rejected',
  'timeout',
  'rss-limit',
  'memory-monitor',
  'spawn',
  'abnormal-exit',
  'output-limit',
  'diagnostic-limit',
  'cancelled',
  'invalid-output',
  'unsupported-platform',
  'recognition-failed',
  'recognition-unavailable',
]);
export type KnowledgeParseReason = z.infer<typeof parseReasonSchema>;

export interface KnowledgeParseDiagnostics {
  elapsedMs?: number;
  exitCode?: number;
  signalNumber?: number;
  rssBytes?: number;
  outputBytes?: number;
  diagnosticBytes?: number;
}

export class KnowledgeParseError extends Error {
  readonly code: KnowledgeParseFailure;
  readonly reason: KnowledgeParseReason;
  readonly retryable: boolean;
  readonly diagnostics: Readonly<KnowledgeParseDiagnostics>;
  constructor(
    readonly failure: KnowledgeParseFailure,
    options: {
      reason?: KnowledgeParseReason;
      diagnostics?: KnowledgeParseDiagnostics;
    } = {},
  ) {
    super(`Knowledge parsing failed (${failure})`);
    this.name = 'KnowledgeParseError';
    this.code = failure;
    this.reason = parseReasonSchema.parse(
      options.reason ?? (failure === 'resource-limited' ? 'content-limit' : 'document-rejected'),
    );
    this.retryable = [
      'timeout',
      'rss-limit',
      'memory-monitor',
      'spawn',
      'abnormal-exit',
      'invalid-output',
      'recognition-failed',
    ].includes(this.reason);
    const diagnostics: KnowledgeParseDiagnostics = {};
    for (const key of [
      'elapsedMs',
      'exitCode',
      'signalNumber',
      'rssBytes',
      'outputBytes',
      'diagnosticBytes',
    ] as const) {
      const value = options.diagnostics?.[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && (key === 'exitCode' || value >= 0))
        diagnostics[key] = value;
    }
    this.diagnostics = Object.freeze(diagnostics);
  }
}

export class KnowledgeParserBusy extends Error {
  constructor() {
    super('Knowledge parser capacity is occupied');
  }
}

export interface KnowledgeParseInput {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
  // Index plain UTF-8 text that the converter rejects as unsupported or malformed, instead of failing.
  rawTextFallback?: boolean;
}

export const metadataSchema = z.strictObject({
  filename: z.string().max(2048),
  mediaType: z.string().max(256),
  rawTextFallback: z.boolean().optional(),
});

export const resultSchema = z
  .strictObject({
    markdown: z
      .string()
      .min(1)
      .refine(value => Buffer.byteLength(value) <= knowledgeLimits.normalizedBytes),
    pages: z.number().int().min(0).max(knowledgeLimits.pages),
    tokens: z.number().int().min(1).max(knowledgeLimits.tokens),
    chunks: z.array(chunkSchema).min(1).max(knowledgeLimits.chunksPerRevision),
    gaps: z.array(coverageGapSchema).max(10_000),
    profile: z.union([
      z.strictObject({
        id: z.string(),
        engine: z.enum(['text', 'anydoc', 'image']),
        version: z.string(),
        normalization: z.string(),
        ocr: z.literal('disabled'),
        // The converter failure that raw-text indexing replaced, when the original could not be converted.
        fallback: z.enum(['unsupported', 'malformed']).optional(),
      }),
      z.strictObject({
        id: z.string(),
        engine: z.enum(['text', 'anydoc', 'image']),
        version: z.string(),
        normalization: z.string(),
        ocr: z.literal('vision'),
        ocrModel: z.string().min(1).max(256),
        ocrPrompt: z.string().min(1).max(64),
      }),
    ]),
  })
  .refine(value => value.chunks.reduce((sum, chunk) => sum + chunk.tokens, 0) <= knowledgeLimits.tokens);
export type KnowledgeParseResult = z.infer<typeof resultSchema>;
export type KnowledgeChunk = KnowledgeParseResult['chunks'][number];

export const responseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), result: resultSchema }),
  z.strictObject({ kind: z.literal('failed'), failure: failureSchema }),
]);

export function parseFailure(error: unknown): KnowledgeParseFailure {
  if (error instanceof KnowledgeParseError) return error.failure;
  if (error instanceof Error && 'code' in error) {
    switch (error.code) {
      case 'unsupported':
        return 'unsupported';
      case 'encrypted':
        return 'encrypted';
      case 'needsOcr':
        return 'ocr-required';
      case 'resourceLimit':
        return 'resource-limited';
    }
  }
  return 'malformed';
}
