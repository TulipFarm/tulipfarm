import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixture, connect, denied } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { requireDraftSources } from '../../../agents/src/draft-sources.ts';
import { createChatTools, parseToolCall } from '../../../agents/src/tools.ts';
import {
  createTableProposals,
  createTableProposalDecisions,
  tableProposalDigest,
} from '../../../tables/dist/proposals.js';
import { definitionSchema, valuesSchema } from '../../src/definition.ts';
import { canonicalJson } from '../../src/canonical.ts';
import { createTableService } from '../../../tables/dist/service.js';
import { createTableWithRows, tableDefinition, textField, textValues } from '../fixture.mjs';
import { AccessDenied } from '@tulipfarm/access';

test(
  'table proposals persist exact effects and enforce requester decisions on restricted PostgreSQL roles',
  { timeout: 120000 },
  async t => {
    const setup = await fixture();
    t.after(() => setup.close());
    await setup.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const workspace = await setup.create(await workspaceTableMigrations());
    const runtime = createWorkspaceRuntime({
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: setup.login(workspace) }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const s = `"${workspace.names.schema}"`;
    const options = { runtime, requireSources: requireDraftSources };
    const proposals = createTableProposals(options);
    const decisions = createTableProposalDecisions({
      ...options,
      resolveConfirmationCredential: async () => setup.login(workspace, 'confirmation'),
    });
    const actor = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
    const chat = randomUUID(),
      turn = randomUUID(),
      message = randomUUID(),
      team = randomUUID();
    const origin = { conversationId: chat, turnId: turn, sources: [] };
    const client = await connect(setup.login(workspace));
    const confirmClient = await connect(setup.login(workspace, 'confirmation'));
    const tables = [];
    const tableService = createTableService(runtime, {}, commonCompatibility);
    async function table({ uniqueStatus = false } = {}) {
      const field = textField('Status'),
        other = textField('Notes'),
        record = randomUUID();
      const definition = {
        ...tableDefinition({ owningTeamId: team, label: 'Tickets', fields: [field, other] }),
        uniqueKeys: uniqueStatus ? [{ id: randomUUID(), fieldIds: [field.id], nulls: 'distinct' }] : [],
      };
      const created = await createTableWithRows({
        db: setup,
        workspace,
        runtime,
        definition,
        records: [{ id: record, values: { ...textValues(field, 'open'), ...textValues(other, 'unchanged') } }],
      });
      const result = {
        id: definition.id,
        field: field.id,
        other: other.id,
        record,
        definition,
        revision: created.revision,
      };
      tables.push(result);
      return result;
    }
    const edit = async (r, fieldId, value) => {
      const row = await tableService.read(workspace.id, workspace.userId, {
        tableId: r.id,
        revision: r.revision,
        recordId: r.record,
      });
      return tableService.mutate(workspace.id, workspace.userId, {
        kind: 'update',
        tableId: r.id,
        revision: r.revision,
        recordId: r.record,
        expectedToken: row.token,
        values: { [fieldId]: { kind: 'text', value } },
      });
    };
    const update = (r, value = 'closed') => ({
      plans: [
        {
          kind: 'records',
          tableId: r.id,
          expectedRevision: r.revision,
          dependsOn: [],
          changes: [{ kind: 'update', recordId: r.record, values: { [r.field]: { kind: 'text', value } } }],
        },
      ],
    });
    const propose = (input, id = randomUUID()) => proposals.propose(workspace.id, actor, id, origin, input);
    const decide = (proposal, decision = 'approve', commandId = randomUUID()) =>
      decisions.decide(workspace.id, actor.userId, chat, proposal.id, { digest: proposal.digest, decision, commandId });
    const status = proposal => proposals.status(workspace.id, actor.userId, chat, proposal.id);
    try {
      await setup.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
      await setup.platform.query(
        `INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`,
        [chat, actor.userId, actor.membershipId],
      );
      await setup.platform.query(
        `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
        [message, chat, actor.membershipId],
      );
      await setup.platform.query(
        `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
        [turn, chat, message],
      );
      const r = await table();
      await t.test(
        'kept unavailable file references are marked while added references need requester access',
        async () => {
          const kept = randomUUID(),
            added = randomUUID(),
            field = randomUUID(),
            recordId = randomUUID();
          const definition = definitionSchema.parse({
            formatVersion: 2,
            id: r.id,
            owningTeamId: team,
            label: 'Files',
            fields: [
              { id: field, kind: 'file', label: 'File', required: false, cardinality: 'many', access: 'independent' },
            ],
            uniqueKeys: [],
          });
          const readable = new Set([added]);
          const checked = [];
          const data = {
            lock: async () => 'capture',
            definition: async () => ({ revision: r.revision, definition }),
            records: async (_tx, _id, after) =>
              after
                ? []
                : [
                    {
                      id: recordId,
                      incarnation: recordId,
                      fieldVersions: { [field]: recordId },
                      values: valuesSchema.parse({ [field]: { kind: 'file', fileIds: [kept] } }),
                    },
                  ],
          };
          const readableFiles = async (_tx, _actor, ids) => {
            checked.push([...ids]);
            return new Set(ids.filter(id => readable.has(id)));
          };
          const service = createTableProposals({ ...options, data, readableFiles });
          const approval = createTableProposalDecisions({
            ...options,
            data,
            readableFiles,
            resolveConfirmationCredential: async () => setup.login(workspace, 'confirmation'),
          });
          const approve = proposal =>
            approval.decide(workspace.id, actor.userId, chat, proposal.id, {
              commandId: randomUUID(),
              digest: proposal.digest,
              decision: 'approve',
            });
          const records = changes => ({
            plans: [{ kind: 'records', tableId: r.id, expectedRevision: r.revision, dependsOn: [], changes }],
          });

          const removal = await service.propose(
            workspace.id,
            actor,
            randomUUID(),
            origin,
            records([{ kind: 'delete', recordId }]),
          );
          assert.deepEqual((await service.effects(workspace.id, actor.userId, chat, removal.id, r.id, {})).items, [
            {
              ordinal: 0,
              effect: { recordId, kind: 'delete', before: { [field]: { kind: 'file', fileIds: [kept] } }, after: null },
              unavailableFileIds: [kept],
            },
          ]);
          assert.equal(
            (await service.read(workspace.id, actor.userId, chat, removal.id)).unavailableFileIds,
            undefined,
          );
          assert.equal((await approve(removal)).status, 'approved');

          const extended = await service.propose(
            workspace.id,
            actor,
            randomUUID(),
            origin,
            records([{ kind: 'update', recordId, values: { [field]: { kind: 'file', fileIds: [kept, added] } } }]),
          );
          assert.deepEqual(
            (await service.effects(workspace.id, actor.userId, chat, extended.id, r.id, {})).items[0]
              .unavailableFileIds,
            [kept],
          );
          assert.deepEqual((await service.read(workspace.id, actor.userId, chat, extended.id)).unavailableFileIds, [
            kept,
          ]);
          readable.delete(added);
          assert.deepEqual(
            (await service.effects(workspace.id, actor.userId, chat, extended.id, r.id, {})).items[0]
              .unavailableFileIds,
            [added, kept].sort(),
          );
          assert.deepEqual(
            (await service.read(workspace.id, actor.userId, chat, extended.id)).unavailableFileIds,
            [added, kept].sort(),
          );
          checked.length = 0;
          await assert.rejects(approve(extended), AccessDenied);
          assert.deepEqual(checked, [[added]]);
          await assert.rejects(
            service.propose(
              workspace.id,
              actor,
              randomUUID(),
              origin,
              records([{ kind: 'update', recordId, values: { [field]: { kind: 'file', fileIds: [kept, added] } } }]),
            ),
            AccessDenied,
          );
          readable.add(added);
          assert.equal((await approve(extended)).status, 'approved');

          readable.delete(added);
          const emptyData = { ...data, records: async () => [] };
          const literal = {
            plans: [
              {
                kind: 'schema',
                tableId: r.id,
                expectedRevision: r.revision,
                dependsOn: [],
                target: definition,
                transforms: {
                  outputs: [
                    { fieldId: field, expression: { op: 'literal', value: { kind: 'file', fileIds: [added] } } },
                  ],
                },
              },
            ],
          };
          await assert.rejects(
            createTableProposals({ ...options, data: emptyData, readableFiles }).propose(
              workspace.id,
              actor,
              randomUUID(),
              origin,
              literal,
            ),
            AccessDenied,
          );
          await assert.rejects(
            createTableProposals({ ...options, data: emptyData }).propose(
              workspace.id,
              actor,
              randomUUID(),
              origin,
              literal,
            ),
            AccessDenied,
          );
          const unhooked = createTableProposals({ ...options, data });
          assert.deepEqual(
            (await unhooked.effects(workspace.id, actor.userId, chat, removal.id, r.id, {})).items[0]
              .unavailableFileIds,
            [kept],
          );
        },
      );
      await t.test('canonical effects, pagination, idempotent decisions and SQL immutability', async () => {
        const id = randomUUID(),
          input = update(r);
        const proposal = await propose(input, id);
        assert.deepEqual(await propose(input, id), proposal);
        await assert.rejects(propose(update(r, 'different'), id), /proposal-conflict/);
        const view = await proposals.read(workspace.id, actor.userId, chat, id);
        assert.equal(view.status, 'pending');
        assert.equal(view.digest, createHash('sha256').update(canonicalJson(view.manifest)).digest('hex'));
        assert.deepEqual(view.manifest.requester, actor);
        const page = await proposals.effects(workspace.id, actor.userId, chat, id, r.id, { limit: 1 });
        assert.deepEqual(page.items, [
          {
            ordinal: 0,
            effect: {
              recordId: r.record,
              kind: 'update',
              before: { [r.field]: { kind: 'text', value: 'open' } },
              after: { [r.field]: { kind: 'text', value: 'closed' } },
            },
          },
        ]);
        assert.equal(page.nextCursor, null);
        await denied(client, `UPDATE ${s}.tf_table_proposals SET digest=$1 WHERE id=$2`, ['0'.repeat(64), id]);
        await denied(client, `DELETE FROM ${s}.tf_table_proposal_effects WHERE proposal_id=$1`, [id]);
        await denied(
          client,
          `INSERT INTO ${s}.tf_table_proposal_decisions(proposal_id,digest,membership_id,command_id,decision) VALUES($1,$2,$3,$4,'approve')`,
          [id, proposal.digest, actor.membershipId, randomUUID()],
        );
        await denied(confirmClient, `UPDATE ${s}.tf_table_proposals SET digest=$1 WHERE id=$2`, ['0'.repeat(64), id]);
        const command = randomUUID();
        assert.equal((await decide(proposal, 'approve', command)).status, 'approved');
        assert.equal((await decide(proposal, 'approve', command)).status, 'approved');
        await assert.rejects(decide(proposal, 'reject', command), /proposal-conflict/);
        assert.equal((await status(proposal)).status, 'approved');
      });
      await t.test('relevant changes require another immutable review', async () => {
        const proposal = await propose(update(r, 'resolved'));
        await decide(proposal);
        await edit(r, r.field, 'waiting');
        assert.equal((await proposals.read(workspace.id, actor.userId, chat, proposal.id)).freshness, 'stale');
        assert.equal((await status(proposal)).status, 'approved');
      });
      await t.test('concurrent decisions converge', async () => {
        const proposal = await propose(update(r, 'serialized'));
        const command = randomUUID();
        const results = await Promise.all([decide(proposal, 'approve', command), decide(proposal, 'approve', command)]);
        assert.deepEqual(
          results.map(result => result.status),
          ['approved', 'approved'],
        );
        assert.equal((await status(proposal)).status, 'approved');
      });
      await t.test('schema effects require schema, read, update and data-removal permission', async () => {
        const target = r.definition;
        const input = {
          plans: [
            {
              kind: 'schema',
              tableId: r.id,
              expectedRevision: r.revision,
              dependsOn: [],
              target: { ...target, fields: target.fields.filter(field => field.id !== r.other) },
              transforms: { outputs: [] },
            },
          ],
        };
        await setup.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [actor.membershipId]);
        await setup.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [
          actor.membershipId,
          team,
        ]);
        for (const permission of ['schema.manage', 'row.read', 'row.update'])
          await setup.platform.query(`INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,$3)`, [
            team,
            r.id,
            `table.${permission}`,
          ]);
        await assert.rejects(propose(input), AccessDenied);
        await setup.platform.query(
          `INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'table.row.delete')`,
          [team, r.id],
        );
        const proposal = await propose(input);
        assert.equal((await proposals.effects(workspace.id, actor.userId, chat, proposal.id, r.id, {})).total, 1);
        await setup.platform.query(`DELETE FROM ${s}.tf_grants WHERE asset_id=$1 AND permission='table.row.read'`, [
          r.id,
        ]);
        await assert.rejects(decide(proposal), AccessDenied);
        await assert.rejects(proposals.read(workspace.id, actor.userId, chat, proposal.id), AccessDenied);
        assert.equal((await status(proposal)).status, 'pending');
        await setup.platform.query(`UPDATE ${s}.tf_memberships SET role='admin' WHERE id=$1`, [actor.membershipId]);
      });
      await t.test('chat tool is proposal-only and binds its server origin', async () => {
        const wire = { tool: 'tables.propose', input: JSON.stringify(update(r, 'tool')) };
        const call = parseToolCall(wire, { kind: 'chat' });
        await assert.rejects(
          createChatTools(runtime).invoke({ workspaceId: workspace.id, actor, callId: randomUUID() }, call),
          AccessDenied,
        );
        assert.throws(() => parseToolCall(wire, { kind: 'agent', tools: ['tables.propose'] }), AccessDenied);
        assert.throws(() => parseToolCall({ ...call, membershipId: randomUUID() }, { kind: 'chat' }));
        const result = await createChatTools(runtime).invoke(
          { workspaceId: workspace.id, actor, callId: randomUUID(), origin },
          call,
        );
        assert.equal(result.status, 'pending');
        assert.equal((await status(result)).decision, null);
        assert.equal('decide' in proposals, false);
        assert.equal('execute' in proposals, false);
        await assert.rejects(
          proposals.propose(
            workspace.id,
            actor,
            randomUUID(),
            { ...origin, turnId: randomUUID() },
            JSON.parse(call.input),
          ),
          AccessDenied,
        );
        assert.equal(
          tableProposalDigest({ b: 2, a: 1 }),
          '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
        );
      });
      await t.test('imports bind source results, deterministic matching and destination audience', async () => {
        const resultId = randomUUID(),
          source = await table(),
          imported = await table({ uniqueStatus: true });
        await setup.platform.query(
          `INSERT INTO ${s}.tf_conversation_tool_calls(id,conversation_id,turn_id,sequence,tool,status) VALUES($1,$2,$3,1,'google.read','completed')`,
          [resultId, chat, turn],
        );
        const rows = [
          { state: { kind: 'text', value: 'open' }, note: { kind: 'text', value: 'updated import' } },
          { state: { kind: 'text', value: 'new ticket' }, note: { kind: 'text', value: 'created import' } },
        ];
        const contentDigest = tableProposalDigest(rows);
        const imports = {
          readSnapshot: async () => ({ contentDigest, sources: [{ kind: 'table', tableId: source.id }], rows }),
        };
        const service = createTableProposals({ ...options, imports });
        const approval = createTableProposalDecisions({
          ...options,
          imports,
          resolveConfirmationCredential: async () => setup.login(workspace, 'confirmation'),
        });
        const input = {
          plans: [
            {
              kind: 'import',
              tableId: imported.id,
              expectedRevision: imported.revision,
              dependsOn: [],
              reference: { kind: 'integration', resultId, contentDigest },
              matchFieldIds: [imported.field],
              mappings: [
                { sourceColumn: 'state', fieldId: imported.field },
                { sourceColumn: 'note', fieldId: imported.other },
              ],
            },
          ],
        };
        const id = randomUUID();
        const proposal = await service.propose(workspace.id, actor, id, origin, input);
        const view = await service.read(workspace.id, actor.userId, chat, id);
        assert.deepEqual(view.manifest.plans[0].audience, {
          policy: 'table-permissions',
          administrators: true,
          teams: [],
          members: [actor.membershipId],
        });
        const first = await service.effects(workspace.id, actor.userId, chat, id, imported.id, { limit: 1 });
        const second = await service.effects(workspace.id, actor.userId, chat, id, imported.id, {
          limit: 1,
          after: first.nextCursor,
        });
        assert.equal(first.total, 2);
        assert.equal(second.nextCursor, null);
        assert.deepEqual([...first.items, ...second.items].map(item => item.effect.kind).sort(), ['create', 'update']);
        await setup.platform.query(
          `INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
          [team, imported.id],
        );
        await assert.rejects(
          approval.decide(workspace.id, actor.userId, chat, id, {
            commandId: randomUUID(),
            digest: proposal.digest,
            decision: 'approve',
          }),
          /proposal-stale/,
        );
        await setup.platform.query(`DELETE FROM ${s}.tf_grants WHERE asset_id=$1`, [imported.id]);
        assert.equal(
          (
            await approval.decide(workspace.id, actor.userId, chat, id, {
              commandId: randomUUID(),
              digest: proposal.digest,
              decision: 'approve',
            })
          ).status,
          'approved',
        );
        rows.push(rows[0]);
        await assert.rejects(service.propose(workspace.id, actor, randomUUID(), origin, input), /invalid-import/);
        rows.pop();
        await assert.rejects(
          proposals.propose(workspace.id, actor, randomUUID(), origin, input),
          /import-adapter-required/,
        );
        await setup.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [actor.membershipId]);
        for (const permission of ['read', 'create', 'update'])
          await setup.platform.query(`INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,$3)`, [
            team,
            imported.id,
            `table.row.${permission}`,
          ]);
        await assert.rejects(service.read(workspace.id, actor.userId, chat, id), AccessDenied);
        assert.equal((await service.status(workspace.id, actor.userId, chat, id)).status, 'approved');
        await setup.platform.query(`UPDATE ${s}.tf_memberships SET role='admin' WHERE id=$1`, [actor.membershipId]);
      });
      await t.test('expired approval and removed membership never execute', async () => {
        const proposal = await propose(update(r, 'expired'));
        await decide(proposal);
        await setup.platform.query(
          `UPDATE ${s}.tf_table_proposals SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1`,
          [proposal.id],
        );
        assert.equal((await status(proposal)).status, 'expired');
        await setup.platform.query(`UPDATE ${s}.tf_memberships SET removed_at=now() WHERE id=$1`, [actor.membershipId]);
        const replacement = randomUUID();
        await setup.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'admin')`, [
          replacement,
          actor.userId,
        ]);
        await assert.rejects(status(proposal), AccessDenied);
      });
    } finally {
      await client.end();
      await confirmClient.end();
      await runtime.close();
    }
  },
);
