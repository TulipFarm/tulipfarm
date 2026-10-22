import { z } from 'zod';
import { skillRuntimePathSchema } from '@tulipfarm/workflow-snippets/skill-protocol';
export const isSkillScript = (path: string) => /\.(?:sh|bash|py|js|mjs|cjs)$/i.test(path);

export const skillPackageLimits = {
  files: 256,
  bytes: 10 * 1024 * 1024,
  skillBytes: 64 * 1024,
  depth: 8,
  pathLength: 512,
  candidates: 100,
  selection: 16,
  sourceBytes: 32 * 1024 * 1024,
  sourceFiles: 10000,
  pending: 4,
  lifetimeMs: 24 * 60 * 60 * 1000,
} as const;
export const skillDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const skillPathSchema = skillRuntimePathSchema;
export const skillFileSchema = z.strictObject({
  path: skillPathSchema,
  digest: skillDigestSchema,
  size: z.number().int().min(0).max(skillPackageLimits.bytes),
});
export const skillMetadataSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
  license: z.string().max(4096).optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string().max(120), z.string().max(4096)).optional(),
  'allowed-tools': z.string().max(4096).optional(),
});
export const skillPackageManifestSchema = z
  .strictObject({
    format: z.literal(1),
    metadata: skillMetadataSchema,
    files: z.array(skillFileSchema).min(1).max(skillPackageLimits.files),
  })
  .superRefine((manifest, ctx) => {
    const paths = new Set<string>();
    let previous = '';
    for (const file of manifest.files) {
      const key = file.path.toLowerCase();
      if (paths.has(key) || file.path <= previous)
        ctx.addIssue({ code: 'custom', message: 'Package files must be unique and sorted by path' });
      paths.add(key);
      previous = file.path;
    }
    for (const file of manifest.files) {
      const parts = file.path.toLowerCase().split('/');
      for (let i = 1; i < parts.length; i++) {
        if (paths.has(parts.slice(0, i).join('/')))
          ctx.addIssue({ code: 'custom', message: 'A package path cannot be both a file and a directory' });
      }
    }
    const skill = manifest.files.find(file => file.path === 'SKILL.md');
    if (!skill || skill.size > skillPackageLimits.skillBytes)
      ctx.addIssue({ code: 'custom', message: 'A bounded root SKILL.md is required' });
    if (manifest.files.reduce((sum, file) => sum + file.size, 0) > skillPackageLimits.bytes)
      ctx.addIssue({ code: 'custom', message: 'Package exceeds the byte limit' });
  });
export const skillPackageSchema = z.strictObject({
  digest: skillDigestSchema,
  manifest: skillPackageManifestSchema,
});
export type SkillPackage = z.infer<typeof skillPackageSchema>;
export type SkillPackageManifest = z.infer<typeof skillPackageManifestSchema>;
export class SkillPackageError extends Error {
  readonly code:
    | 'invalid-package'
    | 'package-limit'
    | 'package-mismatch'
    | 'package-unavailable'
    | 'review-required'
    | 'import-expired'
    | 'import-conflict'
    | 'source-rate-limit'
    | 'source-unavailable'
    | 'source-unsupported'
    | 'source-limit'
    | 'no-skills'
    | 'runtime-unavailable';
  constructor(code: SkillPackageError['code']) {
    super(code);
    this.code = code;
    this.name = 'SkillPackageError';
  }
}
