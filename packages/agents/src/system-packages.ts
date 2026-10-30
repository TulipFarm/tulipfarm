import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  canAccessAsset,
  requireSharedMcpSlots,
  lockAuthorization,
  resolveHuman,
  requireTableCreation,
  requireTablePermission,
  type HumanActor,
} from '@tulipfarm/access';
import { chatAccess } from '@tulipfarm/conversations/chat-access';
import { withMaintenanceTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createGovernanceService } from '@tulipfarm/workspaces/governance';
import { createTableProposals, createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { proposalStatusSchema } from '@tulipfarm/tables/proposal-contracts';
import { reserveTableIdentities } from '@tulipfarm/tables/identities';
import { tableName } from '@tulipfarm/tables/names';
import { activeGeneration, generationProposalData } from '@tulipfarm/tables/store';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import type { TableValues } from '@tulipfarm/tables/definition';
import { createWorkflows } from '@tulipfarm/workflows';
import { createFiles, requireReadableFile, type FileBytes } from '@tulipfarm/files';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { boundRuntime } from './task-approval-gate.ts';
import { tableProposalOptions } from './table-proposals.ts';
import { createWorkspaceSkills, resolveProcedures } from './workspace-skills.ts';
import { createSkillObjects } from './skill-objects.ts';
import { inspectSkillFiles } from './skill-package-review.ts';
import { createAgentSetup, agentSetupScheduleId, type AgentSetupOptions } from './setup.ts';
import { createAgentSchedules } from './schedules.ts';
import { createSavedAgentService } from './saved-service.ts';
import { requireAgentCreation, requireAgentPermission } from './saved-policy.ts';
import { createAgentRecordTools } from './record-tools.ts';
import { inspectTableRecovery } from './system-package-recovery.ts';
import { cyclicTableGroup, installationDependencies, tableShell } from './system-package-tables.ts';
import type { ModelFamilyEligibility } from './model-policy-contracts.ts';
import { agentSetupDraftSchema, agentSetupReceiptSchema, saveAgentSetupDraftSchema } from './setup-contracts.ts';
import {
  importSystemPackageSchema,
  installationResumeSchema,
  installationReviewSchema,
  installationApprovalSchema,
  validateSystemPackageSchema,
  systemPackageSchema,
  packageBindingsSchema,
  installationNodeSchema,
  systemPackageInstallationSchema,
  type SystemPackage,
  type PackageResource,
  type PackageBindings,
  type InstallationNode,
} from './system-package-contracts.ts';
import {
  packageCompiler,
  packageDigest,
  packageIdentity,
  packageAssetBytes,
  validatePackage,
} from './system-package-compiler.ts';

export { validatePackage } from './system-package-compiler.ts';
export const systemPackageCompatibility = { minimum: 21, maximum: commonCompatibility.maximum };
export class SystemPackageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
type Transaction = AgentTransaction & { commonVersion: number };
const rowSchema = z.object({
  id: z.uuid(),
  membership_id: z.uuid(),
  user_id: z.string(),
  conversation_id: z.uuid().nullable(),
  package_digest: z.string(),
  input_digest: z.string(),
  package_approved: z.boolean(),
  package: systemPackageSchema,
  bindings: packageBindingsSchema,
  identities: z.record(z.string(), z.uuid()),
  nodes: z.array(installationNodeSchema),
  version: z.number().int(),
  status: systemPackageInstallationSchema.shape.status,
  created_at: z.date(),
  updated_at: z.date(),
});
type Row = z.infer<typeof rowSchema>;
const operationSchema = z.object({ command_id: z.uuid(), input: z.json(), receipt: z.json().nullable() });
type Options = {
  runtime: AgentStorage;
  resolveConfirmationCredential(workspaceId: string): Promise<string>;
  objects?: (Pick<FileBytes, 'putIfAbsent' | 'read'> & Partial<Pick<FileBytes, 'remove'>>) | undefined;
  modelFamilyEligibility?: ModelFamilyEligibility | undefined;
  identity?: Parameters<typeof createGovernanceService>[0]['identity'] | undefined;
  agentSetup?: AgentSetupOptions | undefined;
  workflows?: Parameters<typeof createWorkflows>[1] | undefined;
  skillRuntimeAvailable?: (() => Promise<boolean>) | undefined;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const seedValues = (values: TableValues) =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [
      id,
      value?.kind === 'numeric'
        ? {
            ...value,
            value: value.value
              .replace(/(\.\d*?)0+$/, '$1')
              .replace(/\.$/, '')
              .replace(/^-0$/, '0'),
          }
        : value,
    ]),
  );
const nodeTitle = (resource: PackageResource) =>
  resource.kind === 'table'
    ? resource.label
    : resource.kind === 'agent'
      ? resource.definition.name
      : resource.kind === 'workflow'
        ? resource.name
        : resource.key;

export function createSystemPackages(options: Options) {
  const { runtime } = options;
  function installationColumns(tx: Transaction) {
    return `installation.*, EXISTS (
      SELECT 1 FROM ${relation(tx, 'tf_system_package_reviews')} approval
      WHERE approval.installation_id=installation.id AND approval.resource_key='$package'
      AND approval.membership_id=installation.membership_id AND approval.attempt=0
      AND approval.digest=installation.input_digest AND approval.decision='approve'
    ) AS package_approved`;
  }
  async function transaction<T>(
    workspaceId: string,
    user: string,
    action: (tx: Transaction, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(z.uuid().parse(workspaceId), systemPackageCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = await resolveHuman(tx, user);
      await currentMember(tx, actor);
      return action(tx, actor);
    });
  }
  async function load(tx: Transaction, actor: HumanActor, id: string) {
    const stored = (
      await tx.client.query(
        `SELECT ${installationColumns(tx)} FROM ${relation(tx, 'tf_system_package_installations')} installation
       WHERE installation.id=$1 AND installation.membership_id=$2 AND installation.user_id=$3 FOR NO KEY UPDATE OF installation`,
        [z.uuid().parse(id), actor.membershipId, actor.userId],
      )
    ).rows[0];
    const row = rowSchema.optional().parse(stored);
    if (!row) throw new AccessDenied();
    if (row.conversation_id) await chatAccess(tx, actor, row.conversation_id);
    if (
      packageDigest(stored.package) !== row.package_digest ||
      packageDigest({ package: stored.package, bindings: stored.bindings }) !== row.input_digest
    )
      throw new SystemPackageError('installation-digest-mismatch');
    return row;
  }
  function view(workspaceId: string, row: Row) {
    return systemPackageInstallationSchema.parse({
      id: row.id,
      workspaceId,
      chatId: row.conversation_id,
      package: row.package.package,
      packageDigest: row.package_digest,
      inputDigest: row.input_digest,
      packageApproved: row.package_approved,
      bindings: row.bindings,
      assets: row.package.assets,
      version: row.version,
      status: row.status,
      nodes: row.nodes,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  }
  async function persist(tx: Transaction, row: Row) {
    const verify = row.nodes.find(node => node.kind === 'verify');
    row.status =
      verify?.state === 'completed' && row.nodes.every(node => node.state === 'completed')
        ? 'completed'
        : row.nodes.some(node => node.state === 'failed')
          ? 'failed'
          : row.nodes.some(node => node.state === 'blocked')
            ? 'blocked'
            : row.nodes.some(node => node.state === 'waiting-review')
              ? 'waiting-review'
              : 'running';
    const updated = (
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_system_package_installations')} SET nodes=$2,status=$3,version=version+1,updated_at=clock_timestamp()
       WHERE id=$1 RETURNING version,updated_at`,
        [row.id, JSON.stringify(row.nodes), row.status],
      )
    ).rows[0];
    row.version = z.number().parse(updated?.version);
    row.updated_at = z.date().parse(updated?.updated_at);
  }
  async function operation(tx: Transaction, row: Row, key: string, name: string) {
    return operationSchema.optional().parse(
      (
        await tx.client.query(
          `SELECT command_id,input,receipt FROM ${relation(tx, 'tf_system_package_operations')}
       WHERE installation_id=$1 AND resource_key=$2 AND operation=$3 AND attempt=$4`,
          [row.id, key, name, attempt(row, key)],
        )
      ).rows[0],
    );
  }
  function attempt(row: Row, key: string) {
    return row.nodes.find(node => node.key === key)?.attempt ?? 0;
  }
  function commandId(row: Row, key: string, name: string) {
    const current = attempt(row, key);
    return packageIdentity(row.id, `command:${key}:${name}${current ? `:attempt:${current}` : ''}`);
  }
  async function recordOperation(tx: Transaction, row: Row, key: string, name: string, input: unknown) {
    const previous = await operation(tx, row, key, name);
    if (previous) {
      if (!same(previous.input, input)) throw new SystemPackageError('operation-input-conflict');
      return previous;
    }
    const id = commandId(row, key, name);
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_system_package_operations')}(installation_id,resource_key,operation,command_id,input,attempt)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [row.id, key, name, id, JSON.stringify(input), attempt(row, key)],
    );
    return { command_id: id, input: z.json().parse(input), receipt: null };
  }
  async function receipt(tx: Transaction, row: Row, key: string, name: string, value: unknown) {
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_system_package_operations')} SET receipt=$4
       WHERE installation_id=$1 AND resource_key=$2 AND operation=$3 AND attempt=$5`,
      [row.id, key, name, JSON.stringify(value), attempt(row, key)],
    );
  }
  function services(tx: Transaction, workspaceId: string) {
    const bound = boundRuntime(tx, workspaceId);
    const objects = options.objects;
    return {
      bound,
      governance: options.identity
        ? createGovernanceService({
            runtime: bound,
            identity: options.identity,
            compatibility: systemPackageCompatibility,
          })
        : null,
      proposals: createTableProposals(tableProposalOptions(bound)),
      decisions: createTableProposalDecisions({
        ...tableProposalOptions(bound),
        resolveConfirmationCredential: options.resolveConfirmationCredential,
      }),
      skills: createWorkspaceSkills(bound),
      objects: options.objects ? createSkillObjects(bound, options.objects) : null,
      setup: createAgentSetup(bound, options.modelFamilyEligibility, options.agentSetup),
      workflows: createWorkflows(bound, options.workflows),
      files: objects?.remove
        ? createFiles(bound, {
            putIfAbsent: objects.putIfAbsent.bind(objects),
            read: objects.read.bind(objects),
            remove: objects.remove.bind(objects),
          })
        : null,
      records: createAgentRecordTools(bound),
    };
  }
  async function preflight(
    tx: Transaction,
    actor: HumanActor,
    workspaceId: string,
    pkg: SystemPackage,
    bindings: PackageBindings,
    installationId?: string,
  ) {
    const result = validatePackage(pkg, bindings);
    if (!result.valid) return result;
    const add = (key: string, code: string, message: string) =>
      result.issues.push({ code, path: `resources.${key}`, message });
    const compiler = packageCompiler(pkg, bindings, installationId ?? randomUUID());
    const { workflows } = services(tx, workspaceId);
    const names = new Set<string>();
    for (const resource of pkg.resources) {
      try {
        if (resource.kind === 'table') {
          await requireTableCreation(tx, actor, compiler.binding(resource.owningTeam.key, 'team'));
          if (resource.sharing && (!options.identity || (await currentMember(tx, actor)).role !== 'admin'))
            add(
              resource.key,
              'table-sharing-authority-required',
              'Native table sharing requires workspace administrator authority and configured governance.',
            );
          const name = tableName(resource.label);
          if (names.has(name)) add(resource.key, 'name-collision', 'Two package tables have the same fixed name');
          names.add(name);
          const collision = (
            await tx.client.query(
              `SELECT table_id FROM ${relation(tx, 'tf_table_names')} WHERE name=$1 AND table_id<>$2`,
              [name, compiler.id(resource.key)],
            )
          ).rowCount;
          if (collision)
            add(
              resource.key,
              'name-collision',
              'A table already owns this fixed name; existing tables are not overwritten',
            );
        }
        if (resource.kind === 'agent') {
          await requireAgentCreation(
            tx,
            actor,
            resource.owningTeam ? compiler.binding(resource.owningTeam.key, 'team') : null,
          );
          await requireSharedMcpSlots(tx, {
            mcp: resource.definition.mcp?.map(({ integration, ...slot }) => ({
              ...slot,
              ...(integration ? { integrationId: compiler.resolve(integration) } : {}),
            })),
          });
          await resolveProcedures(
            tx,
            resource.skills.flatMap(pin =>
              pin.kind === 'resource'
                ? []
                : [
                    {
                      id: pin.kind === 'builtin' ? pin.id : compiler.resolve(pin),
                      revision: pin.revision,
                    },
                  ],
            ),
            actor,
          );
          for (const scope of [...resource.scope, ...(resource.limits ?? [])])
            if ('asset' in scope)
              for (const permission of scope.permissions)
                if (!(await canAccessAsset(tx, actor, compiler.resolve(scope.asset), permission)))
                  throw new AccessDenied();
        }
        if (resource.kind === 'workflow') {
          if (resource.historyAudience && !resource.sponsor)
            add(
              resource.key,
              'sponsor-required',
              'Native workflow history audience requires an explicitly selected sponsor.',
            );
          if (resource.trigger.kind === 'provider')
            await workflows.providers.check(workspaceId, actor.userId, compiler.workflow(resource).trigger);
          for (const step of resource.steps) {
            if (step.kind === 'http' && step.credential)
              await workflows.providers.authorizeIntegration(
                tx,
                compiler.resolve(step.credential.integration),
                actor.membershipId,
              );
            if (step.kind === 'agent' && step.agent.kind === 'input') {
              await requireAgentPermission(tx, actor, compiler.resolve(step.agent), 'read');
              await requireAgentPermission(tx, actor, compiler.resolve(step.agent), 'invoke');
            }
            if (step.kind === 'slack-message') {
              const destination = compiler.resolve(step.destination);
              if (
                !(
                  await tx.client.query(
                    `SELECT 1 FROM ${relation(tx, 'tf_slack_destinations')} WHERE id=$1 AND enabled`,
                    [destination],
                  )
                ).rowCount
              )
                throw new AccessDenied();
            }
          }
        }
        if (resource.kind === 'seed-row')
          for (const value of Object.values(resource.values))
            if (value?.kind === 'file')
              for (const file of value.files)
                if (file.kind === 'input') await requireReadableFile(tx, actor, compiler.resolve(file));
        if (resource.kind === 'integration') {
          const selected = await workflows.providers.check(workspaceId, actor.userId, {
            kind: 'provider',
            integrationId: compiler.integration(resource),
            event: 'created',
            minutes: 5,
          });
          if (!same(selected.source, resource.source))
            add(
              resource.key,
              'integration-source-mismatch',
              'The authorized connection must have exactly the declared source configuration',
            );
        }
        if (
          resource.kind === 'workflow' &&
          resource.steps.some(step => step.kind === 'code') &&
          !options.workflows?.codeSteps &&
          !options.workflows?.snippets
        )
          add(resource.key, 'workflow-code-runtime-unavailable', 'The native workflow code runner is not configured.');
        if (
          resource.kind === 'agent' &&
          resource.slackChannels.length &&
          (!options.agentSetup?.inspectSlack || !options.agentSetup.attachSlack)
        )
          add(resource.key, 'slack-channel-setup-unavailable', 'Native Slack channel setup is not configured.');
        if (
          resource.kind === 'agent' &&
          resource.requestedState === 'active' &&
          resource.schedules.some(schedule => compiler.binding(schedule.sponsor.key, 'member') !== actor.membershipId)
        )
          add(
            resource.key,
            'schedule-sponsor-consent-required',
            'Native agent setup requires the importing person to sponsor each requested schedule.',
          );
        if (resource.kind === 'file' && !options.objects?.remove)
          add(resource.key, 'file-storage-unavailable', 'Native file storage is not configured');
        if (resource.kind === 'skill') {
          if (!options.objects) add(resource.key, 'file-storage-unavailable', 'Skill file storage is not configured');
          const inspection = inspectSkillFiles(
            compiler.skill(resource).files,
            (await options.skillRuntimeAvailable?.()) ?? false,
          );
          for (const finding of inspection.findings.filter(finding => finding.severity === 'blocked'))
            add(resource.key, 'skill-preflight-blocked', `${finding.path}: ${finding.message}`);
        }
      } catch (error) {
        if (error instanceof AccessDenied)
          add(resource.key, 'binding-access-denied', 'The selected resource is not authorized for this person');
        else throw error;
      }
    }
    result.valid = !result.issues.length;
    return result;
  }
  async function validate(workspaceId: string, user: string, value: unknown) {
    const input = validateSystemPackageSchema.parse(value);
    return transaction(workspaceId, user, (tx, actor) =>
      preflight(tx, actor, workspaceId, input.package, input.bindings),
    );
  }
  async function create(workspaceId: string, user: string, value: unknown) {
    const input = importSystemPackageSchema.parse(value);
    if (
      input.approval &&
      (input.approval.packageDigest !== packageDigest(input.package) ||
        input.approval.inputDigest !== packageDigest({ package: input.package, bindings: input.bindings }))
    )
      throw new SystemPackageError('review-digest-conflict');
    const created = await transaction(workspaceId, user, async (tx, actor) => {
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 734812))', [
        `${tx.schema}:${actor.membershipId}:${input.requestId}`,
      ]);
      const previous = (
        await tx.client.query(
          `SELECT id FROM ${relation(tx, 'tf_system_package_installations')} WHERE membership_id=$1 AND request_id=$2`,
          [actor.membershipId, input.requestId],
        )
      ).rows[0];
      if (previous) {
        const row = await load(tx, actor, z.uuid().parse(previous.id));
        if (
          !same(row.package, input.package) ||
          !same(row.bindings, input.bindings) ||
          row.conversation_id !== (input.chatId ?? null)
        )
          throw new SystemPackageError('idempotency-conflict');
        return view(workspaceId, row);
      }
      if (input.chatId) await chatAccess(tx, actor, input.chatId);
      const id = randomUUID();
      const report = await preflight(tx, actor, workspaceId, input.package, input.bindings, id);
      if (!report.valid) throw new SystemPackageError('package-preflight-failed', 400);
      const compiler = packageCompiler(input.package, input.bindings, id);
      const resources = new Map(input.package.resources.map(resource => [resource.key, resource]));
      const identities = Object.fromEntries(
        input.package.resources.map(resource => [
          resource.key,
          resource.kind === 'integration' ? compiler.integration(resource) : compiler.id(resource.key),
        ]),
      );
      const nodes: InstallationNode[] = report.order.map(key => {
        const resource = resources.get(key)!;
        return {
          key,
          attempt: 0,
          kind: resource.kind,
          title: nodeTitle(resource),
          dependsOn: installationDependencies(input.package, resource),
          state: 'pending',
          resourceId: identities[key]!,
          revision: null,
          error: null,
          review: null,
          definition: resource,
        };
      });
      nodes.push({
        key: '$verify',
        attempt: 0,
        kind: 'verify',
        title: 'Verify every installed resource',
        dependsOn: report.order,
        state: 'pending',
        resourceId: null,
        revision: null,
        error: null,
        review: null,
        definition: null,
      });
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_system_package_installations')}
        (id,membership_id,user_id,request_id,conversation_id,package_digest,input_digest,package,bindings,identities,nodes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          actor.membershipId,
          actor.userId,
          input.requestId,
          input.chatId ?? null,
          report.packageDigest,
          report.inputDigest,
          input.package,
          input.bindings,
          identities,
          JSON.stringify(nodes),
        ],
      );
      return view(workspaceId, await load(tx, actor, id));
    });
    return input.approval ? approve(workspaceId, user, created.id, input.approval) : created;
  }
  async function approve(workspaceId: string, user: string, id: string, value: unknown) {
    const input = installationApprovalSchema.parse(value);
    return transaction(workspaceId, user, async (tx, actor) => {
      const row = await load(tx, actor, id);
      if (row.package_digest !== input.packageDigest || row.input_digest !== input.inputDigest)
        throw new SystemPackageError('review-digest-conflict');
      if (row.package_approved && !row.nodes.some(node => node.state === 'waiting-review'))
        return view(workspaceId, row);
      if (!row.package_approved) {
        await withMaintenanceTransaction({
          connectionString: await options.resolveConfirmationCredential(workspaceId),
          workspaceId,
          capability: 'confirmation',
          operation: async confirmation => {
            await confirmation.client.query(
              `INSERT INTO ${relation(confirmation, 'tf_system_package_reviews')}
             (installation_id,resource_key,membership_id,request_id,digest,decision,attempt)
             VALUES($1,'$package',$2,$3,$4,'approve',0)
             ON CONFLICT (installation_id,resource_key,attempt) DO NOTHING`,
              [row.id, actor.membershipId, packageIdentity(row.id, 'approve-package'), row.input_digest],
            );
          },
        });
      }
      const approved = await load(tx, actor, id);
      if (!approved.package_approved) throw new SystemPackageError('review-digest-conflict');
      for (const node of approved.nodes) {
        if (node.state === 'waiting-review') node.state = 'running';
      }
      await persist(tx, approved);
      return view(workspaceId, approved);
    });
  }
  async function prepare(
    tx: Transaction,
    actor: HumanActor,
    workspaceId: string,
    row: Row,
    node: InstallationNode,
    resource: PackageResource,
  ) {
    const compiler = packageCompiler(row.package, row.bindings, row.id);
    const s = services(tx, workspaceId);
    let input: unknown;
    if (resource.kind === 'table' || resource.kind === 'seed-row') {
      const table = resource.kind === 'table' ? resource : compiler.table(resource.table.key);
      const grouped = resource.kind === 'table' && cyclicTableGroup(row.package, resource.key);
      const shell = grouped && node.revision === null;
      if (grouped && !shell) {
        const current = await activeGeneration(tx, compiler.id(table.key));
        if (
          current.revision !== node.revision ||
          !same(current.definition, compiler.definition(tableShell(table))) ||
          (await generationProposalData.records({ ...tx, workspaceId }, compiler.id(table.key), null)).length
        )
          throw new SystemPackageError('table-shell-drift');
      }
      if (resource.kind === 'table') node.definition = shell ? tableShell(resource) : resource;
      input = {
        plans: [
          resource.kind === 'table'
            ? {
                kind: 'schema',
                tableId: compiler.id(table.key),
                dependsOn: [],
                expectedRevision: grouped ? node.revision : null,
                target: compiler.definition(shell ? tableShell(resource) : resource),
                transforms: { outputs: [] },
              }
            : {
                kind: 'records',
                tableId: compiler.id(table.key),
                dependsOn: [],
                expectedRevision: (await activeGeneration(tx, compiler.id(table.key))).revision,
                changes: [{ kind: 'create', recordId: compiler.id(resource.key), values: compiler.rows(resource) }],
              },
        ],
      };
      const op = await recordOperation(tx, row, node.key, 'prepare', input);
      const proposed = await s.proposals.propose(
        workspaceId,
        actor,
        op.command_id,
        { conversationId: null, turnId: null, installationId: row.id, sources: [] },
        input,
      );
      await receipt(tx, row, node.key, 'prepare', proposed);
    } else if (resource.kind === 'skill') {
      const files = compiler.skill(resource);
      if (
        inspectSkillFiles(files.files, (await options.skillRuntimeAvailable?.()) ?? false).findings.some(
          finding => finding.severity === 'blocked',
        )
      )
        throw new SystemPackageError('skill-preflight-blocked');
      input = { definition: files.definition, requestedState: resource.requestedState };
      await recordOperation(tx, row, node.key, 'prepare', input);
    } else if (resource.kind === 'agent') {
      const revisions = Object.fromEntries(
        row.nodes.filter(node => node.revision).map(node => [node.key, node.revision!]),
      );
      const previous = await operation(tx, row, node.key, 'prepare');
      input = previous?.input ?? {
        requestId: commandId(row, node.key, 'prepare'),
        expectedVersion: 0,
        expectedSoulRevision: z
          .string()
          .parse(
            (await tx.client.query(`SELECT revision FROM ${relation(tx, 'tf_soul_head')} WHERE id=1`)).rows[0]
              ?.revision,
          ),
        expectedSavedRevision: null,
        expectedPolicyVersion: 0,
        expectedActivationIds: [],
        setup: compiler.agent(resource, revisions),
      };
      const selected = saveAgentSetupDraftSchema.parse(input);
      if (!previous)
        for (const channel of selected.setup.slackChannels) {
          if (!options.agentSetup?.inspectSlack) throw new SystemPackageError('slack-channel-setup-unavailable');
          const actual = await options.agentSetup.inspectSlack(tx, workspaceId, actor.userId, channel.channel);
          channel.expectedVersion = actual.version;
        }
      input = selected;
      await recordOperation(tx, row, node.key, 'prepare', input);
      const draft = await s.setup.saveDraft(workspaceId, actor, compiler.id(resource.key), input);
      await receipt(tx, row, node.key, 'prepare', draft);
    } else if (resource.kind === 'workflow') {
      input = {
        revision: packageIdentity(row.id, `revision:${node.key}`),
        expectedRevision: null,
        definition: compiler.workflow(resource),
      };
      await recordOperation(tx, row, node.key, 'prepare', input);
    } else if (resource.kind === 'file') {
      const asset = row.package.assets.find(asset => asset.key === resource.asset)!;
      input = {
        id: compiler.id(resource.key),
        name: resource.name,
        mediaType: resource.mimeType,
        sha256: asset.sha256,
      };
      await recordOperation(tx, row, node.key, 'prepare', input);
    } else {
      input = { id: compiler.integration(resource), source: resource.source };
      await recordOperation(tx, row, node.key, 'prepare', input);
    }
    const op = await operation(tx, row, node.key, 'prepare');
    node.review = {
      digest: packageDigest({
        packageDigest: row.package_digest,
        inputDigest: row.input_digest,
        key: node.key,
        attempt: attempt(row, node.key),
        input: op!.input,
        receipt: op!.receipt,
      }),
      description:
        resource.kind === 'table' && cyclicTableGroup(row.package, resource.key)
          ? node.revision === null
            ? 'Create this exact empty shell without relationship fields. Row writes remain blocked. A separate fresh review will apply the full schema after every related shell exists.'
            : 'Apply the full exact schema, including relationships, to the verified empty shell. This is a new review; the shell approval cannot authorize it.'
          : resource.kind === 'integration'
            ? 'Use this existing authorized integration. No provider settings or credentials will be changed.'
            : resource.kind === 'workflow' && resource.requestedState === 'enabled'
              ? 'Save and enable this exact workflow. Enabling its trigger can start real work. You approve the declared sponsorship.'
              : resource.kind === 'agent' && resource.requestedState === 'active'
                ? 'Save and activate this exact agent, including declared grants, team enrollment, schedules and Slack channel replacements. Approval consents to your declared schedule sponsorship and replacements.'
                : `Create this exact ${resource.kind}${resource.kind === 'skill' && resource.requestedState === 'enabled' ? ' and approve its files for use' : ''}.`,
      href: null,
    };
    node.state = 'waiting-review';
  }
  async function recoverTable(
    tx: Transaction,
    actor: HumanActor,
    workspaceId: string,
    row: Row,
    node: InstallationNode,
  ) {
    if (!['table', 'seed-row'].includes(node.kind) || node.state === 'completed' || node.error === 'review-rejected')
      return;
    const prepared = await operation(tx, row, node.key, 'prepare');
    if (!prepared?.receipt) return;
    const proposal = z.object({ id: z.uuid(), digest: z.string() }).parse(prepared.receipt);
    const cancellationId = commandId(row, node.key, 'refresh-cancel');
    const result = await inspectTableRecovery(tx, {
      installationId: row.id,
      proposalId: proposal.id,
      membershipId: actor.membershipId,
      knownStale: node.error === 'proposal-stale',
      cancellationId,
    });
    if (result.kind === 'completed') {
      const resource = row.package.resources.find(resource => resource.key === node.key);
      if (resource?.kind !== 'table' && resource?.kind !== 'seed-row')
        throw new SystemPackageError('resource-kind-conflict');
      await recordOperation(tx, row, node.key, 'apply', { prepared: prepared.input });
      await receipt(tx, row, node.key, 'apply', { reconciled: true, receipts: result.receipts });
      await finishTable(tx, actor, workspaceId, row, node, resource);
      return;
    }
    if (result.kind === 'uncertain') {
      node.state = 'blocked';
      node.error = result.reason;
      return;
    }
    if (result.kind !== 'refresh') return;
    await recordOperation(tx, row, node.key, 'refresh', { proposalId: proposal.id, reason: result.reason });
    await services(tx, workspaceId).decisions.control(workspaceId, actor.userId, null, proposal.id, {
      commandId: cancellationId,
      digest: proposal.digest,
      operation: 'cancel',
    });
    await receipt(tx, row, node.key, 'refresh', {
      previousAttempt: attempt(row, node.key),
      nextAttempt: attempt(row, node.key) + 1,
    });
    node.attempt = attempt(row, node.key) + 1;
    node.review = null;
    node.state = 'pending';
    node.error = null;
  }
  async function tableSharing(tx: Transaction, id: string) {
    const teams = (
      await tx.client.query(
        `SELECT team_id AS "teamId",permission FROM ${relation(tx, 'tf_grants')} WHERE asset_id=$1 ORDER BY team_id,permission`,
        [id],
      )
    ).rows;
    const people = (
      await tx.client.query(
        `SELECT membership_id AS "membershipId",permission FROM ${relation(tx, 'tf_table_person_grants')} WHERE asset_id=$1 ORDER BY membership_id,permission`,
        [id],
      )
    ).rows;
    return {
      teams: z.array(z.object({ teamId: z.uuid(), permission: z.string() })).parse(teams),
      people: z.array(z.object({ membershipId: z.uuid(), permission: z.string() })).parse(people),
    };
  }
  function desiredTableSharing(row: Row, resource: Extract<PackageResource, { kind: 'table' }>) {
    const compiler = packageCompiler(row.package, row.bindings, row.id);
    return {
      teams: resource.sharing!.grants.flatMap(grant =>
        grant.permissions.map(permission => ({ teamId: compiler.binding(grant.team.key, 'team'), permission })),
      ),
      people: resource.sharing!.personGrants.flatMap(grant =>
        grant.permissions.map(permission => ({
          membershipId: compiler.binding(grant.member.key, 'member'),
          permission,
        })),
      ),
    };
  }
  async function finishTable(
    tx: Transaction,
    actor: HumanActor,
    workspaceId: string,
    row: Row,
    node: InstallationNode,
    resource: Extract<PackageResource, { kind: 'table' | 'seed-row' }>,
  ) {
    const compiler = packageCompiler(row.package, row.bindings, row.id);
    const id = compiler.id(resource.kind === 'table' ? resource.key : resource.table.key);
    const actual = await activeGeneration(tx, id);
    if (resource.kind === 'table') {
      const shell = cyclicTableGroup(row.package, resource.key) && node.revision === null;
      if (!same(actual.definition, compiler.definition(shell ? tableShell(resource) : resource)))
        throw new SystemPackageError(`verification-drift:${resource.key}`);
      if (shell) {
        await recordOperation(tx, row, node.key, 'shell', { revision: actual.revision });
        await receipt(tx, row, node.key, 'shell', { id, revision: actual.revision });
        node.revision = actual.revision;
        node.state = 'saved';
        node.attempt = attempt(row, node.key) + 1;
        node.review = null;
        node.error = null;
        return;
      }
      if (resource.sharing) {
        const governance = services(tx, workspaceId).governance;
        if (!governance || (await currentMember(tx, actor)).role !== 'admin')
          throw new SystemPackageError('table-sharing-authority-required');
        const actualGrants = await tableSharing(tx, id),
          expected = desiredTableSharing(row, resource);
        for (const grant of [...actualGrants.teams, ...expected.teams]) {
          const granted = expected.teams.some(item => same(item, grant));
          if (actualGrants.teams.some(item => same(item, grant)) === granted) continue;
          await governance.setGrant(workspaceId, actor.userId, {
            teamId: grant.teamId,
            target: { kind: 'table', id, permission: grant.permission },
            granted,
          });
        }
        for (const grant of [...actualGrants.people, ...expected.people]) {
          const granted = expected.people.some(item => same(item, grant));
          if (actualGrants.people.some(item => same(item, grant)) === granted) continue;
          await governance.setPersonGrant(workspaceId, actor.userId, {
            membershipId: grant.membershipId,
            target: { kind: 'table', id, permission: grant.permission },
            granted,
          });
        }
      }
    }
    node.revision = actual.revision;
    node.state = 'completed';
    node.error = null;
  }
  async function apply(
    tx: Transaction,
    actor: HumanActor,
    workspaceId: string,
    row: Row,
    node: InstallationNode,
    resource: PackageResource,
  ) {
    const compiler = packageCompiler(row.package, row.bindings, row.id);
    const s = services(tx, workspaceId);
    const prepared = await operation(tx, row, node.key, 'prepare');
    if (!prepared) throw new SystemPackageError('operation-missing');
    if (!row.package_approved) {
      const approved = (
        await tx.client.query(
          `SELECT digest,decision FROM ${relation(tx, 'tf_system_package_reviews')} WHERE installation_id=$1 AND resource_key=$2 AND membership_id=$3 AND attempt=$4`,
          [row.id, node.key, actor.membershipId, attempt(row, node.key)],
        )
      ).rows[0];
      if (!approved || approved.digest !== node.review?.digest || approved.decision !== 'approve') return;
    }
    node.state = 'running';
    if (resource.kind === 'table' || resource.kind === 'seed-row') {
      await recordOperation(tx, row, node.key, 'apply', { prepared: prepared.input });
      if (resource.kind === 'table') {
        const definition = compiler.definition(resource);
        const names = await reserveTableIdentities(tx, [{ id: definition.id, label: resource.label }]);
        if (names.get(definition.id)?.name !== tableName(resource.label))
          throw new SystemPackageError('name-collision');
      }
      const proposal = z.object({ id: z.uuid(), digest: z.string() }).parse(prepared.receipt);
      const result = await s.decisions.decide(workspaceId, actor.userId, null, proposal.id, {
        commandId: commandId(row, node.key, 'approve'),
        digest: proposal.digest,
        decision: 'approve',
      });
      const status = proposalStatusSchema.parse(result);
      if (status.status === 'completed') node.state = 'completed';
      else if (['failed', 'partial', 'rejected', 'expired', 'cancelled'].includes(status.status))
        throw new SystemPackageError(`table-proposal-${status.status}`);
      if (node.state === 'completed') {
        await receipt(tx, row, node.key, 'apply', status);
        await finishTable(tx, actor, workspaceId, row, node, resource);
      }
      return;
    }
    const op = await recordOperation(tx, row, node.key, 'apply', {
      prepared: prepared.input,
      requestedState: 'requestedState' in resource ? resource.requestedState : 'bound',
    });
    if (resource.kind === 'skill') {
      if (!s.objects) throw new SystemPackageError('file-storage-unavailable');
      const files = compiler.skill(resource);
      if (
        inspectSkillFiles(files.files, (await options.skillRuntimeAvailable?.()) ?? false).findings.some(
          finding => finding.severity === 'blocked',
        )
      )
        throw new SystemPackageError('skill-preflight-blocked');
      const staged = await s.objects.stage(
        workspaceId,
        actor,
        packageIdentity(row.id, `files:${node.key}`),
        files.files,
      );
      const saved = await s.skills.save(
        workspaceId,
        actor,
        compiler.id(resource.key),
        { requestId: op.command_id, expectedVersion: 0, definition: staged.definition },
        [],
        staged.id,
      );
      const result =
        resource.requestedState === 'enabled'
          ? await s.skills.review(workspaceId, actor, compiler.id(resource.key), {
              requestId: packageIdentity(row.id, `review:${node.key}`),
              expectedVersion: saved.version,
              revision: saved.savedRevision,
            })
          : saved;
      if (resource.sharing) {
        const sharing = await s.skills.sharing(workspaceId, actor.userId, compiler.id(resource.key));
        await s.skills.share(workspaceId, actor.userId, compiler.id(resource.key), {
          version: sharing.version,
          grants: resource.sharing.grants.map(grant => ({
            teamId: compiler.binding(grant.team.key, 'team'),
            permissions: grant.permissions,
          })),
          personGrants: resource.sharing.personGrants.map(grant => ({
            membershipId: compiler.binding(grant.member.key, 'member'),
            permissions: grant.permissions,
          })),
        });
      }
      node.revision = result.savedRevision;
      await receipt(tx, row, node.key, 'apply', result);
    } else if (resource.kind === 'agent') {
      const draft = agentSetupDraftSchema.parse(prepared.receipt);
      const published = await s.setup.publish(workspaceId, actor, compiler.id(resource.key), {
        requestId: op.command_id,
        version: draft.version,
        digest: draft.digest,
        decision: resource.requestedState === 'active' ? 'activate' : 'save',
        consent: {
          sponsorScheduleIds: draft.setup.schedules
            .filter(schedule => schedule.sponsorMembershipId === actor.membershipId)
            .map(schedule => schedule.id),
          replaceChannels: draft.setup.slackChannels
            .filter(channel => channel.replaceAgentId !== null)
            .map(channel => channel.channel),
        },
      });
      const result = agentSetupReceiptSchema.parse(await s.setup.advance(workspaceId, actor, published.commandId));
      await receipt(tx, row, node.key, 'apply', result);
      if (result.status === 'preparing') return;
      if (!['saved', 'active'].includes(result.status))
        throw new SystemPackageError(result.error ?? `agent-${result.status}`);
      if (resource.requestedState === 'active' && result.status !== 'active') return;
      node.revision = z.string().parse(result.savedRevision);
    } else if (resource.kind === 'workflow') {
      let saved = await s.workflows.save(workspaceId, actor.userId, compiler.id(resource.key), prepared.input);
      for (const grant of resource.sharing)
        await s.workflows.share(workspaceId, actor.userId, saved.id, {
          principal: {
            kind: grant.principal.inputKind === 'team' ? 'team' : 'person',
            id: compiler.binding(grant.principal.key, grant.principal.inputKind),
          },
          permissions: grant.permissions,
        });
      if (resource.sponsor)
        saved = await s.workflows.sponsorship(workspaceId, actor.userId, saved.id, {
          sponsorMembershipId: compiler.binding(resource.sponsor.key, 'member'),
          historyAudience: resource.historyAudience?.map(member => compiler.binding(member.key, 'member')) ?? [
            actor.membershipId,
          ],
        });
      if (resource.requestedState === 'enabled') {
        if (resource.sponsor && !saved.sponsorshipAccepted) {
          await receipt(tx, row, node.key, 'apply', {
            id: saved.id,
            revision: saved.revision,
            waitingFor: 'sponsor-consent-required',
          });
          node.state = 'blocked';
          node.error = 'sponsor-consent-required';
          return;
        }
        await s.workflows.activate(workspaceId, actor.userId, saved.id, {
          commandId: op.command_id,
          expectedGeneration: saved.generation,
          revision: saved.revision,
          enabled: true,
        });
      }
      node.revision = saved.revision;
      await receipt(tx, row, node.key, 'apply', { id: saved.id, revision: saved.revision });
    } else if (resource.kind === 'file') {
      if (!s.files) throw new SystemPackageError('file-storage-unavailable');
      const asset = row.package.assets.find(asset => asset.key === resource.asset)!;
      const bytes = packageAssetBytes(asset);
      const saved = await s.files.upload(
        workspaceId,
        actor.userId,
        compiler.id(resource.key),
        {
          name: resource.name,
          parentId: null,
          mediaType: resource.mimeType,
        },
        bytes,
      );
      node.revision = asset.sha256;
      await receipt(tx, row, node.key, 'apply', saved);
    } else {
      const bound = await s.workflows.providers.check(workspaceId, actor.userId, {
        kind: 'provider',
        integrationId: compiler.integration(resource),
        event: 'created',
        minutes: 5,
      });
      if (!same(bound.source, resource.source)) throw new SystemPackageError('integration-source-mismatch');
      await receipt(tx, row, node.key, 'apply', bound);
    }
    node.state = 'completed';
  }
  async function verify(tx: Transaction, actor: HumanActor, workspaceId: string, row: Row) {
    const compiler = packageCompiler(row.package, row.bindings, row.id);
    const s = services(tx, workspaceId);
    const verified = [];
    for (const resource of row.package.resources) {
      const node = row.nodes.find(node => node.key === resource.key)!;
      if (node.state !== 'completed') throw new SystemPackageError(`resource-not-complete:${resource.key}`);
      const id = compiler.id(resource.key);
      if (resource.kind === 'table') {
        await requireTablePermission(tx, actor, id, 'table.row.read');
        const actual = await activeGeneration(tx, id);
        if (actual.revision !== node.revision || !same(actual.definition, compiler.definition(resource)))
          throw new SystemPackageError(`verification-drift:${resource.key}`);
        if (resource.sharing) {
          const grants = await tableSharing(tx, id),
            expected = desiredTableSharing(row, resource);
          const normalized = (items: unknown[]) => [...new Set(items.map(canonicalJson))].sort();
          if (
            !same(normalized(grants.teams), normalized(expected.teams)) ||
            !same(normalized(grants.people), normalized(expected.people))
          )
            throw new SystemPackageError(`verification-drift:${resource.key}`);
        }
        const reverses = (
          await tx.client.query(
            `SELECT target_table,field_id,source_field,label,cardinality FROM ${relation(tx, 'tf_table_reverse_fields')} WHERE source_table=$1`,
            [id],
          )
        ).rows;
        const expectedReverse = compiler.definition(resource).fields.flatMap(field =>
          field.kind === 'relationship' && field.reverse
            ? [
                {
                  target_table: field.targetTableId,
                  field_id: field.reverse.fieldId,
                  source_field: field.id,
                  label: field.reverse.label,
                  cardinality: field.inverseCardinality,
                },
              ]
            : [],
        );
        if (!same(reverses.map(canonicalJson).sort(), expectedReverse.map(canonicalJson).sort()))
          throw new SystemPackageError(`verification-drift:${resource.key}`);
      } else if (resource.kind === 'seed-row') {
        const tableId = compiler.id(resource.table.key);
        const generation = await activeGeneration(tx, tableId);
        const actual = await s.records.getRecord(workspaceId, actor, tableId, generation.revision, id);
        if (!actual || !same(seedValues(actual.values), seedValues(compiler.rows(resource))))
          throw new SystemPackageError(`verification-drift:${resource.key}`);
      } else if (resource.kind === 'skill') {
        const actual = await s.skills.read(workspaceId, actor, id);
        const expected = compiler.skill(resource);
        if (
          actual.revision !== node.revision ||
          !same(actual.definition, expected.definition) ||
          (resource.requestedState === 'saved' &&
            (actual.management?.enabled || actual.management?.activeRevision !== null)) ||
          (resource.requestedState === 'enabled' &&
            (!actual.management?.enabled || actual.management.activeRevision !== actual.revision))
        )
          throw new SystemPackageError(`verification-drift:${resource.key}`);
        if (!s.objects || !actual.definition.package) throw new SystemPackageError('skill-files-unavailable');
        await s.objects.readFiles(workspaceId, actual.definition.package);
        if (resource.sharing) {
          const sharing = await s.skills.sharing(workspaceId, actor.userId, id);
          const normalize = (items: { permissions: string[] }[]) =>
            items
              .map(item => ({ ...item, permissions: [...item.permissions].sort() }))
              .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
          if (
            !same(
              normalize(sharing.grants),
              normalize(
                resource.sharing.grants.map(grant => ({
                  teamId: compiler.binding(grant.team.key, 'team'),
                  permissions: grant.permissions,
                })),
              ),
            ) ||
            !same(
              normalize(sharing.personGrants),
              normalize(
                resource.sharing.personGrants.map(grant => ({
                  membershipId: compiler.binding(grant.member.key, 'member'),
                  permissions: grant.permissions,
                })),
              ),
            )
          )
            throw new SystemPackageError(`verification-drift:${resource.key}`);
        }
      } else if (resource.kind === 'agent') {
        await requireAgentPermission(tx, actor, id, 'read');
        const actual = (
          await tx.client.query(
            `SELECT a.saved_revision,d.definition,a.owning_team_id FROM ${relation(tx, 'tf_agents')} a
           JOIN ${relation(tx, 'tf_agent_saved_revisions')} r ON r.agent_id=a.id AND r.soul_revision=a.saved_revision
           JOIN ${relation(tx, 'tf_agent_definitions')} d ON d.agent_id=r.agent_id AND d.revision=r.definition_revision
           WHERE a.id=$1 AND a.deleted_at IS NULL`,
            [id],
          )
        ).rows[0];
        const prepared = agentSetupDraftSchema.parse((await operation(tx, row, node.key, 'prepare'))?.receipt);
        await requireSharedMcpSlots(tx, prepared.setup.definition);
        await resolveProcedures(tx, prepared.setup.definition.skills, actor);
        const actualDraft = await s.setup.readDraft(workspaceId, actor, id);
        if (!actualDraft || actualDraft.digest !== prepared.digest || !same(actualDraft.setup, prepared.setup))
          throw new SystemPackageError(`verification-drift:${resource.key}`);
        if (
          !actual ||
          actual.saved_revision !== node.revision ||
          !same(actual.definition, prepared.setup.definition) ||
          actual.owning_team_id !== prepared.setup.owningTeamId
        )
          throw new SystemPackageError(`verification-drift:${resource.key}`);
        if (
          resource.requestedState === 'saved' &&
          (
            await tx.client.query(
              `SELECT 1 FROM ${relation(tx, 'tf_agent_activations')} WHERE agent_id=$1 AND revoked_at IS NULL`,
              [id],
            )
          ).rowCount
        )
          throw new SystemPackageError(`verification-drift:${resource.key}`);
        if (resource.requestedState === 'active') {
          const active = (
            await tx.client.query(
              `SELECT scope FROM ${relation(tx, 'tf_agent_activations')} WHERE agent_id=$1 AND revoked_at IS NULL`,
              [id],
            )
          ).rows;
          const policy = await createSavedAgentService(s.bound).policy(workspaceId, actor.userId, id);
          const normalize = (items: { permissions: string[] }[]) =>
            items
              .map(item => ({ ...item, permissions: [...item.permissions].sort() }))
              .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
          const expectedPersonGrants = [
            ...prepared.setup.policy.personGrants.filter(grant => grant.membershipId !== actor.membershipId),
            { membershipId: actor.membershipId, permissions: ['read', 'edit', 'delete', 'invoke', 'manage'] },
          ];
          if (
            !same(normalize(policy.grants), normalize(prepared.setup.policy.grants)) ||
            !same(normalize(policy.personGrants), normalize(expectedPersonGrants))
          )
            throw new SystemPackageError(`verification-drift:${resource.key}`);
          const command = agentSetupReceiptSchema.parse((await operation(tx, row, node.key, 'apply'))?.receipt);
          const schedules = await createAgentSchedules(s.bound).list(workspaceId, actor.userId, id);
          if (schedules.filter(schedule => !schedule.revoked).length !== prepared.setup.schedules.length)
            throw new SystemPackageError(`verification-drift:${resource.key}`);
          for (const expected of prepared.setup.schedules) {
            const actualSchedule = schedules.find(
              schedule => schedule.id === agentSetupScheduleId(command.commandId, expected.id),
            );
            if (
              !actualSchedule ||
              actualSchedule.revoked ||
              !actualSchedule.enabled ||
              actualSchedule.paused ||
              actualSchedule.activationId !== command.activationId ||
              actualSchedule.sponsorMembershipId !== expected.sponsorMembershipId ||
              !same(actualSchedule.action, expected.action) ||
              !same(actualSchedule.trigger, expected.trigger) ||
              actualSchedule.historyAudience.length
            )
              throw new SystemPackageError(`verification-drift:${resource.key}`);
          }
          for (const expected of prepared.setup.slackChannels) {
            if (!options.agentSetup?.inspectSlack) throw new SystemPackageError('slack-channel-setup-unavailable');
            const channel = await options.agentSetup.inspectSlack(tx, workspaceId, actor.userId, expected.channel);
            if (channel.agentId !== (expected.detach ? null : id) || !channel.channelResponses)
              throw new SystemPackageError(`verification-drift:${resource.key}`);
          }
          if (
            active.length !== 1 ||
            !same(active[0]?.scope, prepared.setup.scope) ||
            !same(policy.limits, prepared.setup.limits) ||
            !same(policy.taskLimits, prepared.setup.taskLimits) ||
            !same([...policy.enrollment].sort(), [...prepared.setup.enrollment].sort()) ||
            policy.slackSender !== prepared.setup.slackSender ||
            !policy.enabled
          )
            throw new SystemPackageError(`verification-drift:${resource.key}`);
        }
      } else if (resource.kind === 'workflow') {
        const actual = await s.workflows.definition(workspaceId, actor.userId, id);
        if (actual.definition.trigger.kind === 'provider')
          await s.workflows.providers.check(workspaceId, actor.userId, actual.definition.trigger);
        for (const step of actual.definition.steps) {
          if (step.kind === 'http' && step.credential)
            await s.workflows.providers.authorizeIntegration(tx, step.credential.integrationId, actor.membershipId);
          if (
            step.kind === 'slack-message' &&
            !(
              await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_slack_destinations')} WHERE id=$1 AND enabled`, [
                step.destinationId,
              ])
            ).rowCount
          )
            throw new SystemPackageError(`verification-drift:${resource.key}`);
        }
        const state = (
          await tx.client.query(
            `SELECT enabled,sponsor_membership_id FROM ${relation(tx, 'tf_workflows')} WHERE id=$1`,
            [id],
          )
        ).rows[0];
        if (
          !same(actual.definition, compiler.workflow(resource)) ||
          actual.revision !== node.revision ||
          actual.archived ||
          (resource.requestedState === 'saved' && (state?.enabled || actual.activeRevision !== null)) ||
          (resource.requestedState === 'enabled' && (!state?.enabled || actual.activeRevision !== node.revision)) ||
          (resource.sponsor && state?.sponsor_membership_id !== compiler.binding(resource.sponsor.key, 'member'))
        )
          throw new SystemPackageError(`verification-drift:${resource.key}`);
        const grants = await s.workflows.grants(workspaceId, actor.userId, id);
        const expectedGrants = new Map<
          string,
          { membershipId: string | null; teamId: string | null; permission: string }[]
        >([
          [
            `member:${actor.membershipId}`,
            ['read', 'invoke', 'manage'].map(permission => ({
              membershipId: actor.membershipId,
              teamId: null,
              permission,
            })),
          ],
        ]);
        for (const requested of resource.sharing) {
          const principalId = compiler.binding(requested.principal.key, requested.principal.inputKind);
          expectedGrants.set(
            `${requested.principal.inputKind}:${principalId}`,
            [...new Set(requested.permissions)].map(permission => ({
              membershipId: requested.principal.inputKind === 'member' ? principalId : null,
              teamId: requested.principal.inputKind === 'team' ? principalId : null,
              permission,
            })),
          );
        }
        if (!same(grants.map(canonicalJson).sort(), [...expectedGrants.values()].flat().map(canonicalJson).sort()))
          throw new SystemPackageError(`verification-drift:${resource.key}`);
        if (resource.sponsor) {
          const sponsorship = (
            await tx.client.query(
              `SELECT sponsorship_id,sponsorship_revision FROM ${relation(tx, 'tf_workflows')} WHERE id=$1`,
              [id],
            )
          ).rows[0];
          const audience = (
            await tx.client.query(
              `SELECT membership_id FROM ${relation(tx, 'tf_workflow_history_audience')} WHERE workflow_id=$1 ORDER BY membership_id`,
              [id],
            )
          ).rows.map(member => member.membership_id);
          const expected = resource.historyAudience?.map(member => compiler.binding(member.key, 'member')) ?? [
            actor.membershipId,
          ];
          if (
            !same(audience, [...new Set(expected)].sort()) ||
            (resource.requestedState === 'enabled' &&
              (!sponsorship?.sponsorship_id || sponsorship.sponsorship_revision !== node.revision))
          )
            throw new SystemPackageError(`verification-drift:${resource.key}`);
        }
      } else if (resource.kind === 'file') {
        if (!s.files) throw new SystemPackageError('file-storage-unavailable');
        const actual = await s.files.download(workspaceId, actor.userId, id);
        const asset = row.package.assets.find(asset => asset.key === resource.asset)!;
        if (
          actual.name !== resource.name ||
          actual.mediaType !== resource.mimeType ||
          createHash('sha256').update(actual.bytes).digest('hex') !== asset.sha256
        )
          throw new SystemPackageError(`verification-drift:${resource.key}`);
      } else {
        const actual = await s.workflows.providers.check(workspaceId, actor.userId, {
          kind: 'provider',
          integrationId: compiler.integration(resource),
          event: 'created',
          minutes: 5,
        });
        if (!same(actual.source, resource.source)) throw new SystemPackageError(`verification-drift:${resource.key}`);
      }
      verified.push({ key: resource.key, id: node.resourceId, revision: node.revision });
    }
    await recordOperation(tx, row, '$verify', 'verify', {
      packageDigest: row.package_digest,
      inputDigest: row.input_digest,
    });
    await receipt(tx, row, '$verify', 'verify', { resources: verified, verifiedAt: new Date().toISOString() });
  }
  async function resume(workspaceId: string, user: string, id: string, value: unknown) {
    const input = installationResumeSchema.parse(value);
    return transaction(workspaceId, user, async (tx, actor) => {
      const row = await load(tx, actor, id);
      if (row.version !== input.expectedVersion) throw new SystemPackageError('installation-version-conflict');
      if (row.status === 'completed') return view(workspaceId, row);
      for (const node of row.nodes) {
        const before = structuredClone(node);
        await tx.client.query('SAVEPOINT package_recovery');
        try {
          await recoverTable(tx, actor, workspaceId, row, node);
          await tx.client.query('RELEASE SAVEPOINT package_recovery');
        } catch (error) {
          await tx.client.query('ROLLBACK TO SAVEPOINT package_recovery');
          await tx.client.query('RELEASE SAVEPOINT package_recovery');
          Object.assign(node, before);
          node.state = 'blocked';
          node.error =
            error instanceof SystemPackageError
              ? error.code
              : error instanceof AccessDenied
                ? 'resource-access-denied'
                : 'table-recovery-unavailable';
          continue;
        }
        if (node.state === 'blocked' && node.error !== 'review-rejected') {
          if (node.error?.startsWith('table-recovery-')) continue;
          node.state = node.review ? 'running' : 'pending';
          node.error = null;
        }
      }
      await tx.client.query(`UPDATE ${relation(tx, 'tf_system_package_installations')} SET nodes=$2 WHERE id=$1`, [
        row.id,
        JSON.stringify(row.nodes),
      ]);
      const resources = new Map(row.package.resources.map(resource => [resource.key, resource]));
      for (const node of row.nodes) {
        if (node.state === 'completed' || node.state === 'failed' || node.state === 'blocked') continue;
        if (node.dependsOn.some(key => row.nodes.find(node => node.key === key)?.state !== 'completed')) continue;
        if (node.kind === 'table' && node.revision !== null && node.state === 'saved') {
          const group = cyclicTableGroup(row.package, node.key);
          if (group?.some(table => row.nodes.find(node => node.key === table.key)?.revision === null)) continue;
        }
        const before = structuredClone(node);
        await tx.client.query('SAVEPOINT package_step');
        try {
          if (node.kind === 'verify') {
            await verify(tx, actor, workspaceId, row);
            node.state = 'completed';
            node.error = null;
          } else {
            const resource = resources.get(node.key)!;
            if (!node.review) {
              await prepare(tx, actor, workspaceId, row, node, resource);
              if (row.package_approved) node.state = 'running';
            } else await apply(tx, actor, workspaceId, row, node, resource);
          }
          await tx.client.query('RELEASE SAVEPOINT package_step');
          await tx.client.query(`UPDATE ${relation(tx, 'tf_system_package_installations')} SET nodes=$2 WHERE id=$1`, [
            row.id,
            JSON.stringify(row.nodes),
          ]);
          if (node.state !== 'completed' && node.state !== 'saved') break;
        } catch (error) {
          await tx.client.query('ROLLBACK TO SAVEPOINT package_step');
          Object.assign(node, before);
          node.state = 'blocked';
          node.error =
            error instanceof SystemPackageError
              ? error.code
              : error instanceof AccessDenied
                ? 'resource-access-denied'
                : error instanceof Error && 'code' in error && typeof error.code === 'string'
                  ? error.code
                  : 'resource-operation-unavailable';
          break;
        }
      }
      await persist(tx, row);
      return view(workspaceId, row);
    });
  }
  async function review(workspaceId: string, user: string, id: string, value: unknown) {
    const input = installationReviewSchema.parse(value);
    return transaction(workspaceId, user, async (tx, actor) => {
      const row = await load(tx, actor, id);
      const node = row.nodes.find(node => node.key === input.key && node.kind !== 'verify');
      if (!node?.review || node.review.digest !== input.digest) throw new SystemPackageError('review-digest-conflict');
      const previous = (
        await tx.client.query(
          `SELECT request_id,digest,decision FROM ${relation(tx, 'tf_system_package_reviews')} WHERE installation_id=$1 AND resource_key=$2 AND attempt=$3`,
          [row.id, node.key, attempt(row, node.key)],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.request_id !== input.requestId ||
          previous.digest !== input.digest ||
          previous.decision !== input.decision
        )
          throw new SystemPackageError('review-idempotency-conflict');
        return view(workspaceId, row);
      }
      if (row.version !== input.expectedVersion || node.state !== 'waiting-review')
        throw new SystemPackageError('installation-version-conflict');
      if (
        (
          await tx.client.query(
            `SELECT 1 FROM ${relation(tx, 'tf_system_package_reviews')} WHERE membership_id=$1 AND request_id=$2`,
            [actor.membershipId, input.requestId],
          )
        ).rowCount
      )
        throw new SystemPackageError('review-idempotency-conflict');
      await withMaintenanceTransaction({
        connectionString: await options.resolveConfirmationCredential(workspaceId),
        workspaceId,
        capability: 'confirmation',
        operation: async confirmation => {
          await confirmation.client.query(
            `INSERT INTO ${relation(confirmation, 'tf_system_package_reviews')}
             (installation_id,resource_key,membership_id,request_id,digest,decision,attempt) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              row.id,
              node.key,
              actor.membershipId,
              input.requestId,
              input.digest,
              input.decision,
              attempt(row, node.key),
            ],
          );
        },
      });
      node.state = input.decision === 'reject' ? 'blocked' : 'running';
      node.error = input.decision === 'reject' ? 'review-rejected' : null;
      await persist(tx, row);
      return view(workspaceId, row);
    });
  }
  return {
    validate,
    create,
    approve,
    resume,
    review,
    pending: (workspaceId: string) =>
      runtime.transaction(workspaceId, systemPackageCompatibility, async tx =>
        z.array(z.object({ id: z.uuid(), user_id: z.string(), version: z.number().int() })).parse(
          (
            await tx.client.query(
              `SELECT id,user_id,version FROM ${relation(tx, 'tf_system_package_installations')}
         WHERE status IN ('pending','running') ORDER BY updated_at,id LIMIT 10`,
            )
          ).rows,
        ),
      ),
    read: (workspaceId: string, user: string, id: string) =>
      transaction(workspaceId, user, async (tx, actor) => view(workspaceId, await load(tx, actor, id))),
    list: (workspaceId: string, user: string, after?: string, chatId?: string) =>
      transaction(workspaceId, user, async (tx, actor) => {
        if (chatId) await chatAccess(tx, actor, z.uuid().parse(chatId));
        const rows = z.array(rowSchema).parse(
          (
            await tx.client.query(
              `SELECT ${installationColumns(tx)} FROM ${relation(tx, 'tf_system_package_installations')} installation
         WHERE installation.membership_id=$1 AND installation.user_id=$2
         AND ($3::uuid IS NULL OR installation.id>$3) AND ($4::uuid IS NULL OR installation.conversation_id=$4)
         ORDER BY installation.id LIMIT 26`,
              [actor.membershipId, actor.userId, after ?? null, chatId ?? null],
            )
          ).rows,
        );
        const selected = rows.slice(0, 25);
        return {
          installations: selected.map(row => view(workspaceId, row)),
          nextCursor: rows.length > 25 ? selected.at(-1)!.id : null,
        };
      }),
  };
}
