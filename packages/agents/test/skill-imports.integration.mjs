import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createSkillObjects } from '../src/skill-objects.ts';
import { createSkillImports } from '../src/skill-imports.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { buildSkillPackage } from '../src/skill-packages.ts';
import { createSkillTools } from '../src/skill-tools.ts';
import { createChatTools } from '../src/tools.ts';
import { AccessDenied } from '@tulipfarm/access';
import { createConversations } from '../../conversations/src/index.ts';
import { createConversationExecutor } from '../../conversations/src/runtime.ts';
import { createPersonalMemoryService } from '../../conversations/src/personal-memory.ts';
import { memorySkillBytes, reviewSkillDraft, skillDraftImports } from './skill-draft-fixture.mjs';

test('a chat can review and install its own memory-derived procedure without sharing its draft', async () => {
  const db = await fixture();
  let runtime;
  try {
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
    });
    const table = name => qualified(w.names.schema, name);
    const actor = { kind: 'human', membershipId: w.membershipId, userId: w.userId };
    const other = { kind: 'human', membershipId: randomUUID(), userId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      other.membershipId,
      other.userId,
    ]);
    const memory = createPersonalMemoryService(runtime);
    const savedMemory = await memory.save(w.id, w.userId, {
      content: 'Use a short weekly summary.',
      expectedRevision: 0,
    });
    const bytes = memorySkillBytes();
    const tools = createChatTools(runtime, { objects: { snapshots: bytes } });
    const imports = skillDraftImports(runtime, bytes);
    const objects = createSkillObjects(runtime, bytes);
    const chats = createConversations(runtime);
    const chatId = randomUUID();
    await chats.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await chats.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      model: 'grok-fast',
      parts: [{ kind: 'text', text: 'Create a weekly summary skill that lists completed work and next actions.' }],
    });
    const call = {
      tool: 'skills.draft',
      skillId: 'new',
      input: {
        expectedVersion: 0,
        definition: {
          name: 'Weekly summary',
          description: 'Summarize weekly work.',
          instructions: 'List completed work and next actions.',
        },
      },
    };
    let draft;
    const executor = createConversationExecutor(runtime, async input => {
      assert.equal((await input.readPersonalMemory()).content, 'Use a short weekly summary.');
      draft = await input.executeTool('skills.draft', false, context =>
        createChatTools(context.runtime, { objects: { snapshots: bytes } }).invokeWithSources(context, call),
      );
      assert.equal(draft.result.status, 'pending-review');
      return { text: 'Review the proposed weekly summary skill.', sources: [] };
    });
    assert.equal(
      await executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
      'completed',
    );
    const id = draft.result.importId;
    const view = await imports.read(w.id, actor, id);
    assert.equal(view.candidates[0].definition.name, 'weekly-summary');
    assert.equal(
      view.candidates[0].definition.package.manifest.metadata.description,
      call.input.definition.description,
    );
    const prepared = await objects.readPrepared(w.id, actor, id);
    assert.match(Buffer.from(prepared.files[0].bytes).toString(), /name: "weekly-summary"/);
    for (const name of ['tf_skill_imports', 'tf_skill_packages']) {
      const { sources } = (await db.platform.query(`SELECT sources FROM ${table(name)} WHERE id=$1`, [id])).rows[0];
      assert.ok(
        sources.some(source => source.kind === 'personal-memory' && source.membershipId === actor.membershipId),
      );
    }
    await assert.rejects(imports.read(w.id, other, id), AccessDenied);
    await assert.rejects(objects.readPrepared(w.id, other, id), AccessDenied);
    await assert.rejects(
      tools.invoke(
        {
          workspaceId: w.id,
          actor,
          callId: randomUUID(),
          origin: {
            conversationId: chatId,
            turnId: sent.turnId,
            sources: [{ kind: 'personal-memory', membershipId: other.membershipId }],
          },
        },
        call,
      ),
      AccessDenied,
    );
    const decision = await reviewSkillDraft(imports, w.id, actor, id);
    await assert.rejects(imports.approve(w.id, other.userId, id, decision), AccessDenied);
    const [receipt] = await imports.approve(w.id, w.userId, id, decision);
    assert.equal(receipt.enabled, true);
    assert.equal(receipt.activeRevision, receipt.savedRevision);
    assert.equal((await imports.read(w.id, actor, id)).status, 'installed');
    assert.deepEqual(await imports.approve(w.id, w.userId, id, decision), [receipt]);
    await memory.delete(w.id, w.userId, { expectedRevision: savedMemory.revision });
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='member' WHERE id=$1`, [other.membershipId]);
    await db.platform.query(
      `INSERT INTO ${table('tf_skill_person_grants')} (skill_id,membership_id,permission) SELECT $1,$2,unnest(ARRAY['read','use'])`,
      [receipt.id, other.membershipId],
    );
    const loaded = await tools.invoke(
      { workspaceId: w.id, actor: other, callId: randomUUID() },
      { tool: 'skills.load', skillId: receipt.id, revision: receipt.activeRevision },
    );
    assert.equal(loaded.loaded, true);
    assert.equal(loaded.instructions, call.input.definition.instructions);
    assert.ok(
      (await createWorkspaceSkills(runtime).list(w.id, other, { view: 'reviewed' })).workspace.some(
        skill => skill.id === receipt.id && skill.status === 'enabled',
      ),
    );
    await assert.rejects(imports.read(w.id, other, id), AccessDenied);
  } finally {
    await runtime?.close();
    await db.close();
  }
});

test('imports preserve exact bytes, review only selected skills, and atomically install once', async () => {
  const db = await fixture();
  let runtime;
  try {
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
    });
    const actor = { kind: 'human', membershipId: w.membershipId, userId: w.userId };
    const bytes = new Map();
    const byteStore = {
      async putIfAbsent(key, value) {
        if (!bytes.has(key)) bytes.set(key, Uint8Array.from(value));
      },
      async read(key) {
        if (!bytes.has(key)) throw new Error('missing-object');
        return bytes.get(key);
      },
      async remove(key) {
        bytes.delete(key);
      },
    };
    const objects = createSkillObjects(runtime, byteStore);
    const files = [
      {
        path: 'SKILL.md',
        bytes: Buffer.from('---\nname: sample-skill\ndescription: Repeat a useful task\n---\nFollow the task steps.'),
      },
      { path: 'assets/binary.dat', bytes: Uint8Array.of(0, 255, 128) },
    ];
    const built = buildSkillPackage(files);
    let safetyCalls = 0,
      sourceCalls = 0;
    const imports = createSkillImports(runtime, {
      objects,
      runtimeAvailable: () => false,
      readSource: async () => {
        sourceCalls++;
        return {
          kind: 'skills',
          skills: [
            {
              ...built,
              path: 'sample-skill',
              source: {
                submittedUrl: 'https://example.com/SKILL.md',
                canonicalUrl: 'https://example.com/SKILL.md',
                digest: 'a'.repeat(64),
              },
            },
            {
              ...built,
              path: 'other-skill',
              source: {
                submittedUrl: 'https://example.com/SKILL.md',
                canonicalUrl: 'https://example.com/other/SKILL.md',
                digest: 'b'.repeat(64),
              },
            },
          ],
        };
      },
      review: () => async () => {
        safetyCalls++;
        return { summary: 'The procedure describes a simple task. Binary assets were not assessed.', findings: [] };
      },
    });
    const id = randomUUID(),
      request = { url: 'https://example.com/SKILL.md' };
    assert.equal((await imports.begin(w.id, w.userId, id, request)).status, 'pending');
    await imports.begin(w.id, w.userId, id, request);
    await imports.process(w.id, id);
    let view = await imports.read(w.id, w.userId, id);
    assert.equal(view.status, 'discovered');
    assert.equal(safetyCalls, 0);
    assert.equal(sourceCalls, 1);
    const selected = view.candidates.map(candidate => candidate.id);
    await assert.rejects(
      imports.approve(w.id, w.userId, id, {
        commandId: randomUUID(),
        digest: view.digest,
        selected,
        acknowledgeWarnings: true,
      }),
      /import-conflict/,
    );
    await imports.select(w.id, w.userId, id, { selected });
    await imports.process(w.id, id);
    view = await imports.read(w.id, w.userId, id);
    assert.equal(view.status, 'ready');
    assert.equal(safetyCalls, 2);
    await imports.process(w.id, id);
    assert.equal(safetyCalls, 2);
    const decision = { commandId: randomUUID(), digest: view.digest, selected, acknowledgeWarnings: true };
    await assert.rejects(
      imports.approve(w.id, w.userId, id, { ...decision, selected: selected.slice(0, 1) }),
      /import-conflict/,
    );
    const receipts = await imports.approve(w.id, w.userId, id, decision);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].enabled, true);
    assert.equal(receipts[0].activeRevision, receipts[0].savedRevision);
    assert.deepEqual(await imports.approve(w.id, w.userId, id, decision), receipts);
    await assert.rejects(
      imports.approve(w.id, w.userId, id, { ...decision, commandId: randomUUID() }),
      /import-conflict/,
    );
    const skill = await createWorkspaceSkills(runtime).read(w.id, w.userId, receipts[0].id);
    assert.equal(skill.definition.package.digest, built.definition.package.digest);
    assert.deepEqual([...(await objects.readFile(w.id, skill.definition.package, 'assets/binary.dat'))], [0, 255, 128]);
    await assert.rejects(
      createWorkspaceSkills(runtime).save(w.id, actor, randomUUID(), {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: { ...built.definition, instructions: 'Different from the package bytes.' },
      }),
      /package-mismatch/,
    );
    const other = randomUUID();
    await db.platform.query(
      `INSERT INTO ${qualified(w.names.schema, 'tf_memberships')} (id,user_id,role) VALUES ($1,'other-reader','member')`,
      [other],
    );
    await assert.rejects(imports.read(w.id, 'other-reader', id));
    assert.equal((await imports.read(w.id, w.userId, id)).status, 'installed');
    const original = await imports.provenance(w.id, w.userId, receipts[0].id);
    assert.equal(original.source.canonicalUrl, 'https://example.com/SKILL.md');
    assert.equal(original.localChanges, false);
    const updateId = randomUUID(),
      reviewedBeforeUpdate = safetyCalls;
    await imports.update(w.id, w.userId, receipts[0].id, updateId);
    await imports.process(w.id, updateId);
    assert.equal((await imports.read(w.id, w.userId, updateId)).status, 'unchanged');
    assert.equal(safetyCalls, reviewedBeforeUpdate);
    assert.equal(
      (await createWorkspaceSkills(runtime).read(w.id, actor, receipts[0].id)).management.version,
      receipts[0].version,
    );

    const tools = createSkillTools(runtime, byteStore);
    const draftId = randomUUID();
    const input = {
      expectedVersion: receipts[0].version,
      definition: { name: 'Updated skill', instructions: 'Follow these updated steps.' },
    };
    await tools.draft(w.id, actor, draftId, receipts[0].id, input, []);
    const drafted = await imports.read(w.id, actor, draftId);
    assert.ok(drafted.candidates[0].definition.package.manifest.files.some(file => file.path === 'assets/binary.dat'));
    await tools.draft(w.id, actor, draftId, receipts[0].id, input, []);
    await assert.rejects(
      tools.draft(
        w.id,
        actor,
        draftId,
        receipts[0].id,
        { ...input, definition: { ...input.definition, instructions: 'Different bytes for the same request.' } },
        [],
      ),
      /import-conflict/,
    );

    const abandoned = randomUUID();
    await objects.stage(w.id, actor, abandoned, [
      {
        path: 'SKILL.md',
        bytes: Buffer.from('---\nname: abandoned\ndescription: Not installed\n---\nUnused package.'),
      },
    ]);
    const countBefore = bytes.size;
    await db.platform.query(
      `UPDATE ${qualified(w.names.schema, 'tf_skill_packages')} SET expires_at=now()-interval '2 minutes'`,
    );
    await db.platform.query(
      `UPDATE ${qualified(w.names.schema, 'tf_skill_package_objects')} SET created_at=now()-interval '2 minutes'`,
    );
    await objects.sweep(w.id);
    assert.equal(bytes.size, countBefore - 1);
    assert.deepEqual([...(await objects.readFile(w.id, skill.definition.package, 'assets/binary.dat'))], [0, 255, 128]);
    assert.equal(
      (await imports.read(w.id, actor, draftId)).status,
      'pending-review',
      'Live decisions retain their stages',
    );
    await db.platform.query(
      `UPDATE ${qualified(w.names.schema, 'tf_skill_packages')} SET expires_at=now()+interval '1 hour' WHERE id=$1`,
      [draftId],
    );
    await imports.process(w.id, draftId);
    const readyDraft = await imports.read(w.id, actor, draftId);
    const [updated] = await imports.approve(w.id, actor, draftId, {
      commandId: randomUUID(),
      digest: readyDraft.digest,
      selected: readyDraft.selected,
      acknowledgeWarnings: true,
    });
    const replay = await tools.draft(w.id, actor, draftId, receipts[0].id, input, []);
    assert.equal(replay.status, 'installed', 'Outer chat tool replay survives the target version changing');
    assert.deepEqual(replay.receipts, [updated]);
    assert.match(replay.instruction, /installed by the human/);
    await assert.rejects(
      tools.draft(w.id, actor, draftId, receipts[0].id, { ...input, expectedVersion: updated.version }, []),
      /import-conflict/,
    );
    const history = await imports.history(w.id, actor, updated.id, {});
    assert.equal(history.items.length, 2);
    assert.equal(history.items[0].revision, updated.savedRevision);
    assert.equal(history.items[0].provenance.localChanges, true);
    assert.equal(history.items[1].provenance.source.canonicalUrl, original.source.canonicalUrl);
    assert.equal(history.nextOffset, null);
    await assert.rejects(imports.history(w.id, 'other-reader', updated.id, {}));
    const chat = createChatTools(runtime);
    const context = { workspaceId: w.id, actor, callId: randomUUID() };
    const found = await chat.invoke(context, { tool: 'skills.workspace', search: 'Updated', limit: 10 });
    assert.equal(found.workspace.length, 1);
    const loaded = await chat.invoke(context, {
      tool: 'skills.load',
      skillId: updated.id,
      revision: updated.activeRevision,
    });
    assert.equal(loaded.loaded, true);
    assert.equal(loaded.instructions, 'Follow these updated steps.');
    await createWorkspaceSkills(runtime).setEnabled(w.id, actor, updated.id, {
      requestId: randomUUID(),
      expectedVersion: updated.version,
      enabled: false,
    });
    await assert.rejects(
      chat.invoke(context, { tool: 'skills.load', skillId: updated.id, revision: updated.activeRevision }),
    );
  } finally {
    await runtime?.close();
    await db.close();
  }
});
