import { z } from 'zod';
import { uuidSchema } from '@tulipfarm/access';
import { integrationSourceDependencySchema } from './results.ts';

export const sourceReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('table-read'), tableId: uuidSchema }),
  z.strictObject({ kind: z.literal('schema-read'), tableId: uuidSchema }),
  integrationSourceDependencySchema,
  z.strictObject({ kind: z.literal('project-revision'), projectId: uuidSchema, revisionId: uuidSchema }),
  z.strictObject({ kind: z.literal('requester-only'), membershipId: uuidSchema }),
]);
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
const dependencies = z.array(sourceReferenceSchema).max(512).readonly();
export const provenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('known'), dependencies }),
  z.strictObject({
    kind: z.literal('legacy-unknown'),
    originalReaders: z.array(uuidSchema).min(1).max(512).readonly(),
    dependencies,
  }),
]);
export type Provenance = z.infer<typeof provenanceSchema>;
export const artifactReferenceSchema = z.strictObject({
  kind: z.enum(['message', 'turn', 'tool-result', 'request', 'response', 'approval-request', 'approval-resolution']),
  id: uuidSchema,
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export const provenanceIdSchema = uuidSchema.brand<'ProvenanceId'>();
export type ProvenanceId = z.infer<typeof provenanceIdSchema>;
