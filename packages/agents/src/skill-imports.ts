import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  requireNoMcpDerived,
  requireSkillGrant,
  resolveHuman,
  sourceDependenciesSchema,
  uuidSchema,
  type HumanActor,
  type SourceDependency,
} from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { createWorkspaceSkills } from './workspace-skills.ts';
import { createSkillObjects, skillPackageCompatibility } from './skill-objects.ts';
import { SkillPackageError, skillPackageLimits, type SkillPackage } from './skill-package-contracts.ts';
import { buildSkillPackage, skillDefinitionRevision, type SkillPackageFile } from './skill-packages.ts';
import {
  skillImportCandidateSchema,
  skillImportDecisionSchema,
  skillImportInputSchema,
  skillImportSelectionSchema,
  skillImportViewSchema,
  skillProvenanceSchema,
  type SkillImportView,
} from './skill-import-contracts.ts';
import { createSkillSourceReader, resolveSkillSource } from './skill-import-sources.ts';
import { isSkillScript, reviewSkillPackage, type SkillSafetyReviewer } from './skill-package-review.ts';
import { requireDraftSources } from './draft-sources.ts';
import { workspaceSkillReceiptSchema } from './workspace-skill-contracts.ts';
import { requireSavedSkillSources } from './skill-sources.ts';
import { skillHistoryPageSchema, skillHistoryQuerySchema } from './skill-import-contracts.ts';

type ImportWorker = {
  objects: ReturnType<typeof createSkillObjects>;
  review: (workspaceId: string, actor: HumanActor, importId: string) => SkillSafetyReviewer;
  runtimeAvailable: () => boolean | Promise<boolean>;
  readSource?: ReturnType<typeof createSkillSourceReader>;
};
const candidatesSchema = z.array(skillImportCandidateSchema).max(skillPackageLimits.candidates);
const receiptSchema = z.array(workspaceSkillReceiptSchema).max(skillPackageLimits.selection);
function packageChanges(before: SkillPackage | undefined, after: SkillPackage) {
  const previous = new Map(before?.manifest.files.map(file => [file.path, file.digest]) ?? []);
  const current = new Map(after.manifest.files.map(file => [file.path, file.digest]));
  return [...new Set([...previous.keys(), ...current.keys()])].sort().flatMap(path =>
    previous.get(path) === current.get(path)
      ? []
      : [
          {
            path,
            kind: !previous.has(path)
              ? ('added' as const)
              : !current.has(path)
                ? ('removed' as const)
                : ('changed' as const),
          },
        ],
  );
}
export function skillImportSummary(view: SkillImportView, offset = 0) {
  return {
    importId: view.id,
    status: view.status,
    selected: view.selected,
    error: view.error,
    candidates: view.candidates.slice(offset, offset + 25).map(candidate => ({
      id: candidate.id,
      path: candidate.path,
      name: candidate.definition.name,
      description: candidate.definition.package?.manifest.metadata.description,
    })),
    total: view.candidates.length,
    nextOffset: offset + 25 < view.candidates.length ? offset + 25 : null,
    instruction:
      'Open the existing skill package review to see source files, warnings, and the durable decision. Only a human can install and enable this exact package.',
  };
}

export function createSkillImports(
  runtime: AgentStorage,
  worker?: ImportWorker,
  runtimeAvailable: () => boolean | Promise<boolean> = worker?.runtimeAvailable ?? (() => false),
) {
  async function transaction<T>(
    workspaceId: string,
    user: string | HumanActor,
    operation: (tx: AgentTransaction, actor: HumanActor, bound: AgentStorage) => Promise<T>,
  ) {
    return runtime.transaction(uuidSchema.parse(workspaceId), skillPackageCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = typeof user === 'string' ? await resolveHuman(tx, user) : user;
      await currentMember(tx, actor);
      const bound: AgentStorage = {
        transaction: async (id, range, execute) => {
          if (id !== workspaceId || tx.commonVersion < range.minimum || tx.commonVersion > range.maximum)
            throw new AccessDenied();
          return execute(tx);
        },
      };
      return operation(tx, actor, bound);
    });
  }
  async function load(tx: AgentTransaction, actor: HumanActor, id: string) {
    const row = (
      await tx.client.query(
        `SELECT *,expires_at<=now() AS expired FROM ${relation(tx, 'tf_skill_imports')} WHERE id=$1 AND membership_id=$2`,
        [uuidSchema.parse(id), actor.membershipId],
      )
    ).rows[0];
    if (!row) throw new AccessDenied();
    await requireDraftSources(tx, actor, sourceDependenciesSchema.parse(row.sources));
    return row;
  }
  async function begin(
    workspaceId: string,
    user: string | HumanActor,
    id: string,
    value: unknown,
    origin: readonly SourceDependency[] = [],
  ) {
    id = uuidSchema.parse(id);
    const input = skillImportInputSchema.parse(value);
    if (input.kind !== 'url' || !input.url) throw new SkillPackageError('source-unsupported');
    resolveSkillSource(input.url);
    const sources = sourceDependenciesSchema.parse(origin);
    await transaction(workspaceId, user, async (tx, actor) => {
      await requireNoMcpDerived(tx, sources);
      await requireDraftSources(tx, actor, sources);
      if (input.target) await requireSkillGrant(tx, actor, input.target.id, 'manage');
      const previous = (
        await tx.client.query(
          `SELECT membership_id,input,sources FROM ${relation(tx, 'tf_skill_imports')} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (previous) {
        if (previous.membership_id !== actor.membershipId) throw new AccessDenied();
        if (
          canonicalJson(previous.input) !== canonicalJson(input) ||
          canonicalJson(previous.sources) !== canonicalJson(sources)
        )
          throw new SkillPackageError('import-conflict');
        return;
      }
      const pending = z.coerce
        .number()
        .parse(
          (
            await tx.client.query(
              `SELECT count(*) AS count FROM ${relation(tx, 'tf_skill_imports')} WHERE membership_id=$1 AND status IN ('pending','preparing','discovered','pending-review','reviewing','ready') AND expires_at>now()`,
              [actor.membershipId],
            )
          ).rows[0]?.count,
        );
      if (pending >= skillPackageLimits.pending) throw new SkillPackageError('package-limit');
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_skill_imports')} (id,membership_id,input,sources) VALUES ($1,$2,$3,$4)`,
        [id, actor.membershipId, input, JSON.stringify(sources)],
      );
    });
    return read(workspaceId, user, id);
  }
  async function replayDraft(workspaceId: string, actor: HumanActor, id: string, requestDigest: string) {
    const exists = await transaction(workspaceId, actor, async (tx, human) => {
      const row = (
        await tx.client.query(
          `SELECT membership_id,input,status FROM ${relation(tx, 'tf_skill_imports')} WHERE id=$1`,
          [uuidSchema.parse(id)],
        )
      ).rows[0];
      if (!row) return false;
      if (row.membership_id !== human.membershipId) throw new AccessDenied();
      const input = skillImportInputSchema.parse(row.input);
      if (input.kind !== 'draft' || input.requestDigest !== requestDigest)
        throw new SkillPackageError('import-conflict');
      return row.status !== 'preparing';
    });
    return exists ? read(workspaceId, actor, id) : null;
  }
  async function draft(
    workspaceId: string,
    actor: HumanActor,
    id: string,
    files: readonly SkillPackageFile[],
    origin: readonly SourceDependency[],
    objects: ReturnType<typeof createSkillObjects>,
    target?: { id: string; expectedVersion: number },
    requestDigest?: string,
  ) {
    id = uuidSchema.parse(id);
    const built = buildSkillPackage(files);
    const input = skillImportInputSchema.parse({
      kind: 'draft',
      packageDigest: built.definition.package.digest,
      ...(target ? { target } : {}),
      ...(requestDigest ? { requestDigest } : {}),
    });
    const sources = sourceDependenciesSchema.parse(origin);
    const prepare = await transaction(workspaceId, actor, async (tx, human, bound) => {
      await requireNoMcpDerived(tx, sources);
      await requireDraftSources(tx, human, sources);
      const previous = (
        await tx.client.query(
          `SELECT membership_id,input,sources,status,expires_at>now() AS live FROM ${relation(tx, 'tf_skill_imports')} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (previous) {
        if (previous.membership_id !== actor.membershipId) throw new AccessDenied();
        if (
          canonicalJson(previous.input) !== canonicalJson(input) ||
          canonicalJson(previous.sources) !== canonicalJson(sources)
        )
          throw new SkillPackageError('import-conflict');
        if (!previous.live || previous.status !== 'preparing') return false;
      }
      if (target) {
        const detail = await createWorkspaceSkills(bound).read(workspaceId, human, target.id);
        if (!detail.management || detail.management.version !== target.expectedVersion)
          throw new SkillPackageError('import-conflict');
      }
      if (previous) return true;
      const pending = z.coerce
        .number()
        .parse(
          (
            await tx.client.query(
              `SELECT count(*) AS count FROM ${relation(tx, 'tf_skill_imports')} WHERE membership_id=$1 AND status IN ('pending','preparing','discovered','pending-review','reviewing','ready') AND expires_at>now()`,
              [actor.membershipId],
            )
          ).rows[0]?.count,
        );
      if (pending >= skillPackageLimits.pending) throw new SkillPackageError('package-limit');
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_skill_imports')} (id,membership_id,input,sources,status,started_at) VALUES ($1,$2,$3,$4,'preparing',now())`,
        [id, actor.membershipId, input, JSON.stringify(sources)],
      );
      return true;
    });
    if (!prepare) return read(workspaceId, actor, id);
    const prepared = await objects.stage(workspaceId, actor, id, files, sources);
    await transaction(workspaceId, actor, async (tx, human, bound) => {
      await requireDraftSources(tx, human, sources);
      let changes: ReturnType<typeof packageChanges> | undefined;
      if (target) {
        const detail = await createWorkspaceSkills(bound).read(workspaceId, human, target.id);
        if (!detail.management || detail.management.version !== target.expectedVersion)
          throw new SkillPackageError('import-conflict');
        changes = packageChanges(detail.definition.package, prepared.definition.package);
      }
      const candidate = {
        id,
        path: '',
        definition: prepared.definition,
        source: { submittedUrl: 'chat', canonicalUrl: 'chat', digest: built.definition.package.digest },
        report: null,
        ...(changes ? { changes } : {}),
      };
      const changed = await tx.client.query(
        `UPDATE ${relation(tx, 'tf_skill_imports')} SET status='pending-review',candidates=$2,selected=$3 WHERE id=$1 AND status='preparing' AND expires_at>now()`,
        [id, JSON.stringify([candidate]), JSON.stringify([id])],
      );
      if (!changed.rowCount) throw new SkillPackageError('import-conflict');
    });
    return read(workspaceId, actor, id);
  }
  async function read(workspaceId: string, user: string | HumanActor, id: string): Promise<SkillImportView> {
    return transaction(workspaceId, user, async (tx, actor) => {
      const row = await load(tx, actor, id);
      const decision = (
        await tx.client.query(`SELECT receipts FROM ${relation(tx, 'tf_skill_import_decisions')} WHERE import_id=$1`, [
          id,
        ])
      ).rows[0];
      return skillImportViewSchema.parse({
        id,
        input: row.input,
        status: row.expired && !decision && row.status !== 'unchanged' ? 'expired' : row.status,
        candidates: row.candidates,
        selected: row.selected,
        links: row.links,
        digest: row.digest,
        error: row.error,
        expiresAt: z.date().parse(row.expires_at).toISOString(),
        receipts: decision?.receipts ?? [],
      });
    });
  }
  async function provenance(workspaceId: string, user: string | HumanActor, skillId: string) {
    return transaction(workspaceId, user, async (tx, actor, bound) => {
      const skill = await createWorkspaceSkills(bound).read(workspaceId, actor, skillId);
      const row = (
        await tx.client.query(
          `SELECT provenance FROM ${relation(tx, 'tf_skill_package_provenance')} WHERE skill_id=$1 AND revision=$2`,
          [skillId, skill.revision],
        )
      ).rows[0];
      return row ? skillProvenanceSchema.parse(row.provenance) : null;
    });
  }
  async function history(workspaceId: string, user: string | HumanActor, skillId: string, value: unknown) {
    const { offset } = skillHistoryQuerySchema.parse(value);
    return transaction(workspaceId, user, async (tx, actor, bound) => {
      await createWorkspaceSkills(bound).read(workspaceId, actor, skillId);
      await requireSkillGrant(tx, actor, skillId, 'manage');
      const rows = (
        await tx.client.query(
          `SELECT revision,created_at,provenance FROM ${relation(tx, 'tf_skill_package_provenance')} WHERE skill_id=$1 ORDER BY created_at DESC,revision DESC LIMIT 21 OFFSET $2`,
          [skillId, offset],
        )
      ).rows;
      const items = [];
      for (const row of rows.slice(0, 20)) {
        await requireSavedSkillSources(tx, skillId, row.revision, actor);
        const { report: _report, ...provenance } = skillProvenanceSchema.parse(row.provenance);
        items.push({ revision: row.revision, createdAt: row.created_at.toISOString(), provenance });
      }
      return skillHistoryPageSchema.parse({ items, nextOffset: rows.length > 20 ? offset + 20 : null });
    });
  }
  async function update(workspaceId: string, user: string, skillId: string, importId: string) {
    const input = await transaction(workspaceId, user, async (tx, actor, bound) => {
      const existing = (
        await tx.client.query(
          `SELECT input FROM ${relation(tx, 'tf_skill_imports')} WHERE id=$1 AND membership_id=$2`,
          [uuidSchema.parse(importId), actor.membershipId],
        )
      ).rows[0];
      if (existing) {
        const input = skillImportInputSchema.parse(existing.input);
        if (input.kind !== 'url' || input.target?.id !== skillId) throw new SkillPackageError('import-conflict');
        return input;
      }
      const skill = await createWorkspaceSkills(bound).read(workspaceId, actor, skillId);
      if (!skill.management || skill.lifecycle !== 'active') throw new AccessDenied();
      const row = (
        await tx.client.query(
          `SELECT provenance FROM ${relation(tx, 'tf_skill_package_provenance')} WHERE skill_id=$1 AND revision=$2`,
          [skillId, skill.revision],
        )
      ).rows[0];
      const previous = row ? skillProvenanceSchema.parse(row.provenance) : null;
      if (!previous || previous.source.submittedUrl === 'chat') throw new SkillPackageError('source-unsupported');
      return {
        kind: 'url' as const,
        url: previous.source.submittedUrl,
        sourcePath: previous.path,
        target: { id: skillId, expectedVersion: skill.management.version },
      };
    });
    return begin(workspaceId, user, importId, input);
  }
  async function cancel(workspaceId: string, user: string | HumanActor, id: string) {
    await transaction(workspaceId, user, async (tx, actor) => {
      const row = await load(tx, actor, id);
      if (row.status === 'installed') throw new SkillPackageError('import-conflict');
      await tx.client.query(`UPDATE ${relation(tx, 'tf_skill_imports')} SET status='cancelled' WHERE id=$1`, [id]);
    });
    return read(workspaceId, user, id);
  }
  async function select(workspaceId: string, user: string | HumanActor, id: string, value: unknown) {
    const input = skillImportSelectionSchema.parse(value);
    await transaction(workspaceId, user, async (tx, actor) => {
      const row = await load(tx, actor, id);
      if (row.expired) throw new SkillPackageError('import-expired');
      if (
        ['pending-review', 'reviewing', 'ready'].includes(row.status) &&
        canonicalJson(row.selected) === canonicalJson(input.selected)
      )
        return;
      if (row.status !== 'discovered') throw new SkillPackageError('import-conflict');
      const candidates = candidatesSchema.parse(row.candidates);
      if (input.selected.some(candidateId => !candidates.some(candidate => candidate.id === candidateId)))
        throw new SkillPackageError('import-conflict');
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_skill_imports')} SET selected=$2,status='pending-review' WHERE id=$1`,
        [id, JSON.stringify(input.selected)],
      );
    });
    return read(workspaceId, user, id);
  }
  async function process(workspaceId: string, id: string) {
    if (!worker) throw new SkillPackageError('package-unavailable');
    id = uuidSchema.parse(id);
    const claimed = await runtime.transaction(uuidSchema.parse(workspaceId), skillPackageCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const row = (
        await tx.client.query(
          `SELECT i.*,m.user_id FROM ${relation(tx, 'tf_skill_imports')} i JOIN ${relation(tx, 'tf_memberships')} m ON m.id=i.membership_id AND m.removed_at IS NULL WHERE i.id=$1 AND i.status IN ('pending','pending-review') AND i.expires_at>now()`,
          [id],
        )
      ).rows[0];
      if (!row) return null;
      const actor: HumanActor = {
        kind: 'human',
        membershipId: uuidSchema.parse(row.membership_id),
        userId: z.string().parse(row.user_id),
      };
      await requireDraftSources(tx, actor, sourceDependenciesSchema.parse(row.sources));
      await requireNoMcpDerived(tx, sourceDependenciesSchema.parse(row.sources));
      const phase = row.status === 'pending' ? 'preparing' : 'reviewing';
      await tx.client.query(`UPDATE ${relation(tx, 'tf_skill_imports')} SET status=$2,started_at=now() WHERE id=$1`, [
        id,
        phase,
      ]);
      return {
        actor,
        phase,
        input: skillImportInputSchema.parse(row.input),
        sources: sourceDependenciesSchema.parse(row.sources),
        candidates: candidatesSchema.parse(row.candidates),
        selected: z.array(uuidSchema).max(skillPackageLimits.selection).parse(row.selected),
      };
    });
    if (!claimed) return;
    async function live() {
      await transaction(workspaceId, claimed!.actor, async (tx, actor) => {
        const row = await load(tx, actor, id);
        if (row.status !== claimed!.phase || row.expired) throw new SkillPackageError('import-expired');
      });
    }
    try {
      if (claimed.phase === 'reviewing') {
        const candidates = claimed.candidates;
        for (const candidate of candidates) {
          if (!claimed.selected.includes(candidate.id)) continue;
          await live();
          const prepared = await worker.objects.readPrepared(workspaceId, claimed.actor, candidate.id);
          const { report } = await reviewSkillPackage(
            candidate.id,
            prepared.package,
            prepared.files,
            worker.review(workspaceId, claimed.actor, id),
            prepared.package.manifest.files.some(file => isSkillScript(file.path))
              ? await worker.runtimeAvailable()
              : false,
          );
          candidate.report = report;
        }
        await transaction(workspaceId, claimed.actor, async (tx, actor) => {
          const row = await load(tx, actor, id);
          if (row.status !== claimed.phase || row.expired) throw new SkillPackageError('import-expired');
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_skill_imports')} SET status='ready',candidates=$2,digest=$3 WHERE id=$1`,
            [id, JSON.stringify(candidates), skillDefinitionRevision({ input: claimed.input, candidates })],
          );
        });
        return;
      }
      if (!claimed.input.url) throw new SkillPackageError('source-unsupported');
      const result = await (worker.readSource ?? createSkillSourceReader())(claimed.input.url);
      const candidates: z.infer<typeof candidatesSchema> = [];
      if (result.kind === 'skills') {
        const sourcePath = claimed.input.sourcePath;
        const packages =
          sourcePath === undefined ? result.skills : result.skills.filter(skill => skill.path === sourcePath);
        if (!packages.length) throw new SkillPackageError('package-unavailable');
        if (claimed.input.target && packages.length === 1) {
          const current = await createWorkspaceSkills(runtime).read(
            workspaceId,
            claimed.actor,
            claimed.input.target.id,
          );
          if (!current.management || current.management.version !== claimed.input.target.expectedVersion)
            throw new SkillPackageError('import-conflict');
          if (current.definition.package?.digest === packages[0]!.definition.package.digest) {
            await transaction(workspaceId, claimed.actor, async (tx, actor) => {
              const row = await load(tx, actor, id);
              if (row.status !== 'preparing' || row.expired) throw new SkillPackageError('import-expired');
              await tx.client.query(`UPDATE ${relation(tx, 'tf_skill_imports')} SET status='unchanged' WHERE id=$1`, [
                id,
              ]);
            });
            return;
          }
        }
        for (const skill of packages) {
          await live();
          const packageId = randomUUID();
          const prepared = await worker.objects.stage(
            workspaceId,
            claimed.actor,
            packageId,
            skill.files,
            claimed.sources,
          );
          await live();
          const target = claimed.input.target
            ? await createWorkspaceSkills(runtime).read(workspaceId, claimed.actor, claimed.input.target.id)
            : null;
          if (claimed.input.target && target?.management?.version !== claimed.input.target.expectedVersion)
            throw new SkillPackageError('import-conflict');
          candidates.push({
            id: packageId,
            path: skill.path,
            definition: prepared.definition,
            source: skill.source,
            report: null,
            ...(target ? { changes: packageChanges(target.definition.package, prepared.definition.package) } : {}),
          });
        }
      }
      await transaction(workspaceId, claimed.actor, async (tx, actor) => {
        const row = await load(tx, actor, id);
        if (row.status !== 'preparing' || row.expired) throw new SkillPackageError('import-expired');
        const digest = result.kind === 'skills' ? skillDefinitionRevision({ input: claimed.input, candidates }) : null;
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_skill_imports')} SET status=$2,candidates=$3,links=$4,digest=$5 WHERE id=$1`,
          [
            id,
            result.kind === 'skills' ? 'discovered' : result.kind,
            JSON.stringify(candidates),
            JSON.stringify(result.kind === 'links' ? result.links : []),
            digest,
          ],
        );
      });
    } catch (error) {
      await runtime.transaction(workspaceId, skillPackageCompatibility, tx =>
        tx.client.query(
          `UPDATE ${relation(tx, 'tf_skill_imports')} SET status='failed',error=$2 WHERE id=$1 AND status IN ('preparing','reviewing')`,
          [id, error instanceof SkillPackageError ? error.code : 'preparation-failed'],
        ),
      );
      throw error;
    }
  }
  async function approve(workspaceId: string, user: string, id: string, value: unknown) {
    const input = skillImportDecisionSchema.parse(value);
    const snapshot = await read(workspaceId, user, id);
    const available =
      snapshot.status === 'ready' &&
      snapshot.candidates.some(
        candidate =>
          input.selected.includes(candidate.id) &&
          candidate.definition.package?.manifest.files.some(file => isSkillScript(file.path)),
      )
        ? await runtimeAvailable()
        : false;
    return transaction(workspaceId, user, async (tx, actor, bound) => {
      const row = await load(tx, actor, id);
      const previous = (
        await tx.client.query(
          `SELECT import_id,input,receipts FROM ${relation(tx, 'tf_skill_import_decisions')} WHERE import_id=$1 OR (membership_id=$2 AND command_id=$3)`,
          [id, actor.membershipId, input.commandId],
        )
      ).rows[0];
      if (previous) {
        if (previous.import_id !== id || canonicalJson(previous.input) !== canonicalJson(input))
          throw new SkillPackageError('import-conflict');
        return receiptSchema.parse(previous.receipts);
      }
      if (row.expired) throw new SkillPackageError('import-expired');
      if (
        row.status !== 'ready' ||
        row.digest !== input.digest ||
        canonicalJson(row.selected) !== canonicalJson(input.selected)
      )
        throw new SkillPackageError('import-conflict');
      await requireNoMcpDerived(tx, sourceDependenciesSchema.parse(row.sources));
      const request = skillImportInputSchema.parse(row.input);
      const candidates = candidatesSchema.parse(row.candidates);
      const selected = input.selected.map(candidateId => {
        const candidate = candidates.find(item => item.id === candidateId);
        if (!candidate?.report || candidate.report.packageDigest !== candidate.definition.package?.digest)
          throw new SkillPackageError('import-conflict');
        if (candidate.definition.package.manifest.files.some(file => isSkillScript(file.path)) && !available)
          throw new SkillPackageError('runtime-unavailable');
        const findings = [...candidate.report.deterministic, ...candidate.report.ai.findings];
        if (
          findings.some(finding => finding.severity === 'blocked') ||
          (!input.acknowledgeWarnings && findings.some(finding => finding.severity === 'high'))
        )
          throw new SkillPackageError('review-required');
        return candidate;
      });
      if (request.target && selected.length !== 1) throw new SkillPackageError('import-conflict');
      const service = createWorkspaceSkills(bound);
      const receipts = [];
      for (const candidate of selected) {
        const target = request.target ?? { id: randomUUID(), expectedVersion: 0 };
        const current = request.target ? await service.read(workspaceId, actor, target.id) : null;
        const oldRow = current
          ? (
              await tx.client.query(
                `SELECT provenance FROM ${relation(tx, 'tf_skill_package_provenance')} WHERE skill_id=$1 AND revision=$2`,
                [target.id, current.revision],
              )
            ).rows[0]
          : null;
        const previous = oldRow ? skillProvenanceSchema.parse(oldRow.provenance) : null;
        if (request.kind === 'url' && previous?.localChanges && !input.replaceLocalChanges)
          throw new SkillPackageError('review-required');
        const saved = await service.save(
          workspaceId,
          actor,
          target.id,
          { requestId: randomUUID(), expectedVersion: target.expectedVersion, definition: candidate.definition },
          sourceDependenciesSchema.parse(row.sources),
          candidate.id,
        );
        receipts.push(
          await service.review(workspaceId, actor, target.id, {
            requestId: randomUUID(),
            expectedVersion: saved.version,
            revision: saved.savedRevision,
          }),
        );
        const provenance = skillProvenanceSchema.parse({
          source: request.kind === 'draft' && previous ? previous.source : candidate.source,
          path: request.kind === 'draft' && previous ? previous.path : candidate.path,
          report: candidate.report,
          kind: request.kind,
          parentRevision: current?.revision ?? null,
          localChanges: request.kind === 'draft' && previous !== null,
        });
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_skill_package_provenance')} (skill_id,revision,import_id,provenance) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [target.id, saved.savedRevision, id, provenance],
        );
      }
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_skill_import_decisions')} (import_id,membership_id,command_id,input,receipts) VALUES ($1,$2,$3,$4,$5)`,
        [id, actor.membershipId, input.commandId, input, JSON.stringify(receipts)],
      );
      await tx.client.query(`UPDATE ${relation(tx, 'tf_skill_imports')} SET status='installed' WHERE id=$1`, [id]);
      return receipts;
    });
  }
  async function pending(workspaceId: string) {
    return runtime.transaction(uuidSchema.parse(workspaceId), skillPackageCompatibility, async tx => {
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_skill_imports')} SET status='failed',error='preparation-interrupted' WHERE status IN ('preparing','reviewing') AND started_at<now()-interval '20 minutes'`,
      );
      return z
        .array(z.object({ id: uuidSchema }))
        .parse(
          (
            await tx.client.query(
              `SELECT id FROM ${relation(tx, 'tf_skill_imports')} WHERE status IN ('pending','pending-review') AND expires_at>now() ORDER BY created_at LIMIT 20`,
            )
          ).rows,
        );
    });
  }
  return { begin, draft, replayDraft, read, cancel, select, process, approve, pending, provenance, history, update };
}
