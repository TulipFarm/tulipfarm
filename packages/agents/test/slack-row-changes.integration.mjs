import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { lockAuthorization } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createTableWithRows, tableDefinition, text, textField } from '../../tables/test/fixture.mjs';
import { slackRowChangeCards } from '../src/slack-row-changes.ts';

test(
  'Slack row cards show only written values and label links the requester can read',
  { timeout: 120000 },
  async t => {
    const f = await conversationFixture();
    t.after(() => f.close());
    const w = f.workspace;
    const team = randomUUID(),
      otherTeam = randomUUID();
    await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Support'),($2,'Sales')`, [
      team,
      otherTeam,
    ]);
    const member = async teamId => {
      const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
      await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
        actor.membershipId,
        actor.userId,
      ]);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
        actor.membershipId,
        teamId,
      ]);
      return actor;
    };
    const owner = await member(team),
      outsider = await member(otherTeam);
    const grant = (teamId, tableId) =>
      f.db.platform.query(
        `INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
        [teamId, tableId],
      );

    const personName = textField('Name');
    const mohit = randomUUID();
    const people = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      definition: tableDefinition({ owningTeamId: team, label: 'People', fields: [personName] }),
      records: [{ id: mohit, values: { [personName.id]: text('Mohit Sharma') } }],
    });
    const title = textField('Title'),
      secret = textField('Internal note'),
      open = randomUUID();
    const status = { id: randomUUID(), label: 'Status', kind: 'single-select', required: false, options: [] };
    status.options.push({ id: open, label: 'Todo', retired: false });
    const assignee = {
      id: randomUUID(),
      label: 'Assignee',
      kind: 'relationship',
      required: false,
      targetTableId: people.tableId,
      cardinality: 'one',
      inverseCardinality: 'many',
      reverse: null,
      onDelete: 'restrict',
    };
    const tickets = await createTableWithRows({
      db: f.db,
      workspace: w,
      runtime: f.runtime,
      definition: tableDefinition({ owningTeamId: team, label: 'Tickets', fields: [title, status, assignee, secret] }),
    });
    await grant(team, tickets.tableId);
    await grant(otherTeam, tickets.tableId);
    await grant(team, people.tableId);

    const chatId = randomUUID();
    await f.store.create(w.id, owner.userId, { chatId, commandId: randomUUID() });
    const { turnId } = await f.store.send(w.id, owner.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      parts: [{ kind: 'text', text: 'Create a ticket for Mohit.' }],
    });
    const recordId = randomUUID(),
      callId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversation_tool_calls')} (id,conversation_id,turn_id,sequence,tool,status) VALUES ($1,$2,$3,1,'rows.create','completed')`,
      [callId, chatId, turnId],
    );
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_conversation_execution_steps')} (call_id,turn_id,call,sources,output) VALUES ($1,$2,$3,'[]',$4)`,
      [
        callId,
        turnId,
        {
          tool: 'rows.create',
          tableId: tickets.tableId,
          expectedAppliedRevision: tickets.revision,
          recordId,
          values: {
            [title.id]: text('Fix login redirect loop'),
            [status.id]: { kind: 'single-select', optionId: open },
            [assignee.id]: { kind: 'relationship', tableId: people.tableId, recordIds: [mohit] },
          },
        },
        { result: { id: recordId } },
      ],
    );

    const cards = (actor, link) =>
      f.runtime.transaction(w.id, commonCompatibility, async tx => {
        await lockAuthorization(tx, 'write');
        return slackRowChangeCards(tx, w.id, actor, chatId, turnId, link);
      });
    const blocksText = attachment => JSON.stringify(attachment.blocks);

    const [card] = await cards(
      owner,
      async (_, tableId, id) => `https://app.example.com/acme/tables/${tableId}?row=${id}`,
    );
    assert.equal(card.color, '#146c2f');
    assert.deepEqual(card.blocks[0].text, {
      type: 'mrkdwn',
      text: `*<https://app.example.com/acme/tables/${tickets.tableId}?row=${recordId}|Fix login redirect loop>*`,
    });
    assert.deepEqual(
      card.blocks[1].fields.map(field => field.text),
      ['*Status*\nTodo', '*Assignee*\nMohit Sharma'],
    );
    assert.match(card.blocks[2].elements[0].text, /^Tickets {2}\| {2}Created /);
    assert.doesNotMatch(blocksText(card), /Internal note/);

    // Without read access to People, the linked person's name stays out of the card.
    const [unlinked] = await cards(outsider);
    assert.equal(unlinked.blocks[0].text.text, '*Fix login redirect loop*');
    assert.doesNotMatch(blocksText(unlinked), /Mohit/);

    await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE team_id=$1 AND asset_id=$2`, [
      otherTeam,
      tickets.tableId,
    ]);
    assert.deepEqual(await cards(outsider), []);
  },
);
