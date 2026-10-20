import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requireNoMcpDerived,
  sourceDependenciesSchema,
  uuidSchema,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { chargedBytes, type FileBytes } from '@tulipfarm/files';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { requireDraftSources } from './draft-sources.ts';
import {
  SkillPackageError,
  skillDigestSchema,
  skillPackageLimits,
  skillPackageSchema,
  skillPathSchema,
  type SkillPackage,
} from './skill-package-contracts.ts';
import {
  buildSkillPackage,
  skillBytesDigest,
  verifySkillManifest,
  verifySkillPackage,
  type SkillPackageFile,
} from './skill-packages.ts';

export const skillPackageCompatibility = { minimum: 1, maximum: commonCompatibility.maximum };
const lockQuota = (tx: AgentTransaction) =>
  tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209871))', [tx.schema]);
const keyFor = (workspaceId: string, digest: string) =>
  `${uuidSchema.parse(workspaceId)}/skills/${skillDigestSchema.parse(digest)}`;

export async function requireStoredSkillPackage(
  tx: AgentTransaction,
  actor: HumanActor,
  pkg: SkillPackage,
  packageId?: string,
) {
  verifySkillManifest(pkg);
  const row = (
    await tx.client.query(
      `SELECT id,manifest,instructions,sources FROM ${relation(tx, 'tf_skill_packages')}
    WHERE membership_id=$1 AND digest=$2 AND ready AND expires_at>now() AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC LIMIT 1`,
      [actor.membershipId, pkg.digest, packageId ?? null],
    )
  ).rows[0];
  if (!row || canonicalJson(row.manifest) !== canonicalJson(pkg.manifest))
    throw new SkillPackageError('package-unavailable');
  const sources = sourceDependenciesSchema.parse(row.sources);
  await requireNoMcpDerived(tx, sources);
  await requireDraftSources(tx, actor, sources);
  return { id: uuidSchema.parse(row.id), instructions: z.string().parse(row.instructions), sources };
}

export function createSkillObjects(
  runtime: AgentStorage,
  objects: Pick<FileBytes, 'putIfAbsent' | 'read'> & Partial<Pick<FileBytes, 'remove'>>,
  options: { quotaBytes?: number } = {},
) {
  const quota = z
    .number()
    .int()
    .positive()
    .parse(options.quotaBytes ?? 1024 * 1024 * 1024);
  async function transaction<T>(
    workspaceId: string,
    actor: HumanActor,
    operation: (tx: AgentTransaction) => Promise<T>,
  ) {
    return runtime.transaction(uuidSchema.parse(workspaceId), skillPackageCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      await currentMember(tx, actor);
      return operation(tx);
    });
  }
  async function stage(
    workspaceId: string,
    actor: HumanActor,
    id: string,
    input: readonly SkillPackageFile[],
    origin: readonly SourceDependency[] = [],
  ) {
    id = uuidSchema.parse(id);
    const { definition, files } = buildSkillPackage(input);
    const pkg = definition.package;
    const sources = sourceDependenciesSchema.parse(origin);
    await transaction(workspaceId, actor, async tx => {
      await requireNoMcpDerived(tx, sources);
      await requireDraftSources(tx, actor, sources);
      await lockQuota(tx);
      const previous = (
        await tx.client.query(
          `SELECT membership_id,digest,sources,expires_at>now() AS live FROM ${relation(tx, 'tf_skill_packages')} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (previous) {
        if (previous.membership_id !== actor.membershipId) throw new AccessDenied();
        if (previous.digest !== pkg.digest || canonicalJson(previous.sources) !== canonicalJson(sources))
          throw new SkillPackageError('import-conflict');
        if (!previous.live) throw new SkillPackageError('import-expired');
        return;
      }
      const pending = z.coerce.number().parse(
        (
          await tx.client.query(
            `SELECT count(*) AS count FROM ${relation(tx, 'tf_skill_packages')} p
        WHERE membership_id=$1 AND expires_at>now() AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_skill_revision_packages')} r WHERE r.package_id=p.id)`,
            [actor.membershipId],
          )
        ).rows[0]?.count,
      );
      if (pending >= skillPackageLimits.pending * skillPackageLimits.candidates)
        throw new SkillPackageError('package-limit');
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_skill_packages')} (id,membership_id,digest,manifest,instructions,sources) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, actor.membershipId, pkg.digest, pkg.manifest, definition.instructions, JSON.stringify(sources)],
      );
      for (const file of pkg.manifest.files) {
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_skill_package_objects')} (digest,size) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [file.digest, file.size],
        );
        if (
          (
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_skill_package_objects')} WHERE digest=$1 AND (deleting OR size<>$2)`,
              [file.digest, file.size],
            )
          ).rowCount
        )
          throw new SkillPackageError('package-unavailable');
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_skill_package_files')} (package_id,path,digest) VALUES ($1,$2,$3)`,
          [id, file.path, file.digest],
        );
      }
      if ((await chargedBytes(tx)) > quota) throw new SkillPackageError('package-limit');
    });
    for (const file of files) {
      const digest = skillBytesDigest(file.bytes);
      await transaction(workspaceId, actor, async tx => {
        await requireDraftSources(tx, actor, sources);
        if (
          !(
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_skill_packages')} WHERE id=$1 AND membership_id=$2 AND expires_at>now()`,
              [id, actor.membershipId],
            )
          ).rowCount
        )
          throw new SkillPackageError('import-expired');
      });
      const signal = AbortSignal.timeout(20000);
      await objects.putIfAbsent(keyFor(workspaceId, digest), file.bytes, signal);
      const stored = await objects.read(keyFor(workspaceId, digest), file.bytes.byteLength, signal);
      if (skillBytesDigest(stored) !== digest) throw new SkillPackageError('package-mismatch');
    }
    await transaction(workspaceId, actor, async tx => {
      await requireNoMcpDerived(tx, sources);
      await requireDraftSources(tx, actor, sources);
      const changed = await tx.client.query(
        `UPDATE ${relation(tx, 'tf_skill_packages')} SET ready=true WHERE id=$1 AND membership_id=$2 AND digest=$3 AND expires_at>now()`,
        [id, actor.membershipId, pkg.digest],
      );
      if (!changed.rowCount) throw new SkillPackageError('import-expired');
    });
    return { id, definition };
  }
  async function readFiles(workspaceId: string, pkg: SkillPackage) {
    const parsed = verifySkillManifest(pkg);
    const files: SkillPackageFile[] = [];
    for (const file of parsed.manifest.files) {
      const bytes = await objects.read(keyFor(workspaceId, file.digest), file.size);
      if (bytes.byteLength !== file.size || skillBytesDigest(bytes) !== file.digest)
        throw new SkillPackageError('package-mismatch');
      files.push({ path: file.path, bytes });
    }
    return verifySkillPackage(parsed, files).files;
  }
  async function readPrepared(workspaceId: string, actor: HumanActor, id: string) {
    id = uuidSchema.parse(id);
    const pkg = await transaction(workspaceId, actor, async tx => {
      const row = (
        await tx.client.query(
          `SELECT digest,manifest,sources FROM ${relation(tx, 'tf_skill_packages')}
        WHERE id=$1 AND membership_id=$2 AND ready AND expires_at>now()`,
          [id, actor.membershipId],
        )
      ).rows[0];
      if (!row) throw new AccessDenied();
      await requireDraftSources(tx, actor, sourceDependenciesSchema.parse(row.sources));
      return skillPackageSchema.parse({ digest: row.digest, manifest: row.manifest });
    });
    const files = await readFiles(workspaceId, pkg);
    await transaction(workspaceId, actor, tx => requireStoredSkillPackage(tx, actor, pkg, id));
    return { package: pkg, files };
  }
  async function readFile(workspaceId: string, pkg: SkillPackage, path: string) {
    verifySkillManifest(pkg);
    path = skillPathSchema.parse(path);
    const file = pkg.manifest.files.find(item => item.path === path);
    if (!file) throw new SkillPackageError('package-unavailable');
    const bytes = await objects.read(keyFor(workspaceId, file.digest), file.size);
    if (bytes.byteLength !== file.size || skillBytesDigest(bytes) !== file.digest)
      throw new SkillPackageError('package-mismatch');
    return bytes;
  }
  async function sweep(workspaceId: string) {
    uuidSchema.parse(workspaceId);
    if (!objects.remove) throw new SkillPackageError('package-unavailable');
    const doomed = await runtime.transaction(workspaceId, skillPackageCompatibility, async tx => {
      await lockQuota(tx);
      // The grace period outlasts every transfer admitted before a stage expired.
      const expired = (
        await tx.client.query(
          `SELECT p.id FROM ${relation(tx, 'tf_skill_packages')} p WHERE p.expires_at<now()-interval '1 minute'
        AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_skill_revision_packages')} r WHERE r.package_id=p.id)
        AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_skill_imports')} i WHERE i.expires_at>now() AND i.status IN ('pending','preparing','discovered','pending-review','reviewing','ready') AND (i.id=p.id OR i.candidates @> jsonb_build_array(jsonb_build_object('id',p.id::text))))
        ORDER BY p.expires_at LIMIT 100`,
          [],
        )
      ).rows.map(row => uuidSchema.parse(row.id));
      await tx.client.query(`DELETE FROM ${relation(tx, 'tf_skill_package_files')} WHERE package_id=ANY($1::uuid[])`, [
        expired,
      ]);
      await tx.client.query(`DELETE FROM ${relation(tx, 'tf_skill_packages')} WHERE id=ANY($1::uuid[])`, [expired]);
      return z.array(z.object({ digest: skillDigestSchema })).parse(
        (
          await tx.client
            .query(`UPDATE ${relation(tx, 'tf_skill_package_objects')} o SET deleting=true WHERE digest IN (
        SELECT p.digest FROM ${relation(tx, 'tf_skill_package_objects')} p WHERE p.created_at<now()-interval '1 minute'
        AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_skill_package_files')} f WHERE f.digest=p.digest)         ORDER BY p.created_at LIMIT 2) RETURNING digest`)
        ).rows,
      );
    });
    for (const object of doomed) {
      await objects.remove(keyFor(workspaceId, object.digest));
      await runtime.transaction(workspaceId, skillPackageCompatibility, async tx => {
        await lockQuota(tx);
        await tx.client.query(
          `DELETE FROM ${relation(tx, 'tf_skill_package_objects')} o WHERE digest=$1 AND deleting
          AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_skill_package_files')} f WHERE f.digest=o.digest)`,
          [object.digest],
        );
      });
    }
    return { removed: doomed.length };
  }
  return { stage, readPrepared, readFile, readFiles, sweep };
}
