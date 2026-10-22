import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import {
  SkillPackageError,
  skillMetadataSchema,
  skillPackageLimits,
  skillPackageManifestSchema,
  skillPackageSchema,
  skillPathSchema,
  type SkillPackage,
} from './skill-package-contracts.ts';

export type SkillPackageFile = { path: string; bytes: Uint8Array };
export const skillBytesDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const skillDefinitionRevision = (definition: object) => skillBytesDigest(Buffer.from(canonicalJson(definition)));

export function readSkillDocument(bytes: Uint8Array, directoryName?: string) {
  if (bytes.byteLength > skillPackageLimits.skillBytes) throw new SkillPackageError('package-limit');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SkillPackageError('invalid-package');
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new SkillPackageError('invalid-package');
  const doc = parseDocument(match[1]!, { uniqueKeys: true, version: '1.2', schema: 'core', strict: true });
  if (doc.errors.length || doc.warnings.length) throw new SkillPackageError('invalid-package');
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new SkillPackageError('invalid-package');
  }
  const metadata = skillMetadataSchema.safeParse(data);
  if (!metadata.success || (directoryName !== undefined && metadata.data.name !== directoryName))
    throw new SkillPackageError('invalid-package');
  const instructions = match[2]!.trim();
  if (!instructions || instructions.length > 32000 || instructions.includes('\0'))
    throw new SkillPackageError('invalid-package');
  return { metadata: metadata.data, instructions };
}

export function buildSkillPackage(input: readonly SkillPackageFile[], directoryName?: string) {
  if (
    !input.length ||
    input.length > skillPackageLimits.files ||
    input.reduce((sum, file) => sum + file.bytes.byteLength, 0) > skillPackageLimits.bytes
  )
    throw new SkillPackageError('package-limit');
  const files = input
    .map(file => ({ path: skillPathSchema.parse(file.path), bytes: Uint8Array.from(file.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skill = files.find(file => file.path === 'SKILL.md');
  if (!skill) throw new SkillPackageError('invalid-package');
  const { metadata, instructions } = readSkillDocument(skill.bytes, directoryName);
  const manifest = skillPackageManifestSchema.parse({
    format: 1,
    metadata,
    files: files.map(file => ({ path: file.path, digest: skillBytesDigest(file.bytes), size: file.bytes.byteLength })),
  });
  const pkg = { manifest, digest: skillDefinitionRevision(manifest) };
  return { definition: { name: metadata.name, instructions, package: pkg }, files };
}

export function verifySkillPackage(value: unknown, files: readonly SkillPackageFile[]) {
  const expected = skillPackageSchema.parse(value);
  const actual = buildSkillPackage(files);
  if (canonicalJson(actual.definition.package) !== canonicalJson(expected))
    throw new SkillPackageError('package-mismatch');
  return actual;
}

export function verifySkillManifest(pkg: SkillPackage) {
  const parsed = skillPackageSchema.parse(pkg);
  if (skillDefinitionRevision(parsed.manifest) !== parsed.digest) throw new SkillPackageError('package-mismatch');
  return parsed;
}
