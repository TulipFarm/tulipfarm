import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access/contracts';
import { skillDigestSchema, skillPackageLimits } from './skill-package-contracts.ts';
import { workspaceSkillDefinitionSchema, workspaceSkillReceiptSchema } from './workspace-skill-contracts.ts';

export const skillFindingSchema = z.strictObject({
  severity: z.enum(['blocked', 'high', 'medium', 'low']),
  path: z.string().max(512),
  line: z.number().int().positive().nullable(),
  message: z.string().min(1).max(1000),
});
export const skillSafetyReportSchema = z.strictObject({
  version: z.literal(1),
  packageDigest: skillDigestSchema,
  runtimeProfile: z.literal('skill-runtime-v1'),
  deterministic: z.array(skillFindingSchema).max(256),
  ai: z.strictObject({
    summary: z.string().min(1).max(2000),
    findings: z
      .array(skillFindingSchema.omit({ severity: true }).extend({ severity: z.enum(['high', 'medium', 'low']) }))
      .max(40),
  }),
  unreviewedFiles: z.array(z.string().max(512)).max(skillPackageLimits.files),
});
export const skillImportInputSchema = z
  .strictObject({
    url: z.string().trim().min(1).max(4096).optional(),
    kind: z.enum(['url', 'draft']).default('url'),
    packageDigest: skillDigestSchema.optional(),
    requestDigest: skillDigestSchema.optional(),
    sourcePath: z.string().max(512).optional(),
    target: z.strictObject({ id: uuidSchema, expectedVersion: z.number().int().positive() }).optional(),
  })
  .refine(
    input =>
      input.kind === 'url'
        ? input.url !== undefined && input.packageDigest === undefined && input.requestDigest === undefined
        : input.url === undefined && input.packageDigest !== undefined,
    'A URL import requires a source URL; a chat draft requires its package digest',
  );
export const skillImportCandidateSchema = z.strictObject({
  id: uuidSchema,
  path: z.string().max(512),
  definition: workspaceSkillDefinitionSchema,
  source: z.strictObject({
    submittedUrl: z.string(),
    canonicalUrl: z.string(),
    digest: z.string(),
    repository: z.string().optional(),
    commit: z.string().optional(),
    directory: z.string().optional(),
  }),
  report: skillSafetyReportSchema.nullable(),
  changes: z
    .array(z.strictObject({ path: z.string().max(512), kind: z.enum(['added', 'changed', 'removed']) }))
    .max(512)
    .optional(),
});
export const skillPreviewQuerySchema = z.strictObject({
  path: z.string().min(1).max(512),
  offset: z.coerce.number().int().min(0).max(10485760).default(0),
});
export const skillPreviewSchema = z.strictObject({
  path: z.string(),
  kind: z.enum(['text', 'binary']),
  size: z.number().int().nonnegative(),
  text: z.string().max(16000).nullable(),
  nextOffset: z.number().int().nullable(),
});
export const skillImportViewSchema = z.strictObject({
  id: uuidSchema,
  input: skillImportInputSchema,
  status: z.enum([
    'pending',
    'preparing',
    'discovered',
    'pending-review',
    'reviewing',
    'ready',
    'links',
    'page',
    'failed',
    'cancelled',
    'installed',
    'expired',
    'unchanged',
  ]),
  candidates: z.array(skillImportCandidateSchema).max(skillPackageLimits.candidates),
  selected: z.array(uuidSchema).max(skillPackageLimits.selection),
  links: z.array(z.string()).max(skillPackageLimits.candidates),
  digest: skillDigestSchema.nullable(),
  error: z.string().nullable(),
  expiresAt: z.string(),
  receipts: z.array(workspaceSkillReceiptSchema).max(skillPackageLimits.selection),
});
export const skillImportDecisionSchema = z.strictObject({
  commandId: uuidSchema,
  digest: skillDigestSchema,
  selected: z
    .array(uuidSchema)
    .min(1)
    .max(skillPackageLimits.selection)
    .refine(ids => new Set(ids).size === ids.length, 'Select each skill once'),
  acknowledgeWarnings: z.boolean(),
  replaceLocalChanges: z.boolean().default(false),
});
export const skillImportSelectionSchema = skillImportDecisionSchema.pick({ selected: true });
export type SkillSafetyReport = z.infer<typeof skillSafetyReportSchema>;
export type SkillFinding = z.infer<typeof skillFindingSchema>;
export type SkillImportView = z.infer<typeof skillImportViewSchema>;
export const skillProvenanceSchema = z.strictObject({
  source: skillImportCandidateSchema.shape.source,
  path: z.string().max(512),
  report: skillSafetyReportSchema,
  kind: z.enum(['url', 'draft']),
  parentRevision: skillDigestSchema.nullable(),
  localChanges: z.boolean(),
});
export const skillHistoryQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export const skillHistoryPageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        revision: skillDigestSchema,
        createdAt: z.iso.datetime(),
        provenance: skillProvenanceSchema.omit({ report: true }),
      }),
    )
    .max(20),
  nextOffset: z.number().int().nonnegative().nullable(),
});
