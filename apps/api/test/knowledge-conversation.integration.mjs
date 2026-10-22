import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConversationKnowledge } from '@tulipfarm/knowledge';
import { knowledgeFixture } from './knowledge-fixture.mjs';

test('HTTP grouped chat search, original and citations retain exact private and project audiences', async () => {
  const f = await knowledgeFixture({ filesEnabled: false });
  try {
    const service = createConversationKnowledge({ runtime: f.runtime });
    const owner = { kind: 'human', userId: f.signed.owner.id, membershipId: f.workspace.membershipId };
    const other = { kind: 'human', userId: f.signed.admin.id, membershipId: f.adminMembership };
    async function publish(requester, title, projectId = null) {
      const conversationId = randomUUID(),
        coverageMessageId = randomUUID();
      const input = {
        workspaceId: f.workspace.id,
        conversationId,
        generation: 1,
        coveredThrough: 1,
        coverageMessageId,
        title,
        text: `${title}: violet delivery and open work.`,
        sources: [],
        requester,
      };
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_conversations')} (id,owner_user_id,owner_membership_id,project_id,is_closed,activity_generation,next_message_sequence)
        VALUES ($1,$2,$3,$4,true,1,3)`,
        [conversationId, requester.userId, requester.membershipId, projectId],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_conversation_messages')} (id,conversation_id,sequence,author_kind,membership_id)
        VALUES ($1,$2,2,'human',$3)`,
        [coverageMessageId, conversationId, requester.membershipId],
      );
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_conversation_maintenance')}
        (id,conversation_id,generation,state,requester_user_id,requester_membership_id,covered_through,coverage_message_id,sources,recap)
        VALUES ($1,$2,1,'publishing',$3,$4,1,$5,'[]',$6)`,
        [randomUUID(), conversationId, requester.userId, requester.membershipId, coverageMessageId, input.text],
      );
      return { input, ...(await service.publish(input)) };
    }
    const privateOwner = await publish(owner, 'Owner secret');
    const privateOther = await publish(other, 'Other secret');
    const search = cookie =>
      f.call('/search', {
        method: 'POST',
        cookie,
        body: { kind: 'typing', query: 'violet', filters: { kinds: ['conversation'] } },
      });
    const mine = await search(f.signed.owner.cookie),
      theirs = await search(f.signed.admin.cookie);
    assert.equal(mine.status, 200, mine.bytes.toString());
    assert.equal(theirs.status, 200, theirs.bytes.toString());
    assert.deepEqual(
      mine.json().hits.map(hit => hit.citation.documentId),
      [privateOwner.documentId],
    );
    assert.deepEqual(
      theirs.json().hits.map(hit => hit.citation.documentId),
      [privateOther.documentId],
    );
    const ownCitation = mine.json().hits[0].citation,
      otherCitation = theirs.json().hits[0].citation;
    assert.equal(ownCitation.sourceId, otherCitation.sourceId);
    async function check(citation, cookie, expected) {
      const evidence = await f.call('/evidence', { method: 'POST', body: citation, cookie });
      assert.equal(evidence.status, expected, evidence.bytes.toString());
      const original = await f.call(`/documents/${citation.documentId}/original?revisionId=${citation.revisionId}`, {
        cookie,
      });
      assert.equal(original.status, expected, original.bytes.toString());
      const retained = await f.call(`/citations/${citation.publicationId}:${citation.ordinal}`, { cookie });
      assert.equal(retained.status, expected, retained.bytes.toString());
      if (expected === 200) {
        assert.equal(evidence.json().original.kind, 'conversation');
        assert.equal(retained.json().source, 'conversation');
        assert.match(original.bytes.toString(), /violet/);
      }
    }
    await check(ownCitation, f.signed.owner.cookie, 200);
    await check(otherCitation, f.signed.owner.cookie, 404);
    await check(ownCitation, f.signed.admin.cookie, 404);
    const projectId = randomUUID();
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_projects')} (id,name,creator_membership_id) VALUES ($1,'Shared project',$2)`,
      [projectId, owner.membershipId],
    );
    for (const actor of [owner, other])
      await f.db.platform.query(
        `INSERT INTO ${f.table('tf_project_members')} (project_id,membership_id,role) VALUES ($1,$2,'member')`,
        [projectId, actor.membershipId],
      );
    const shared = await publish(owner, 'Shared recap', projectId);
    const sharedCitation = (await search(f.signed.admin.cookie))
      .json()
      .hits.find(hit => hit.citation.documentId === shared.documentId).citation;
    await check(sharedCitation, f.signed.admin.cookie, 200);
    await f.db.platform.query(
      `UPDATE ${f.table('tf_project_members')} SET removed_at=clock_timestamp() WHERE project_id=$1 AND membership_id=$2`,
      [projectId, other.membershipId],
    );
    await check(sharedCitation, f.signed.admin.cookie, 404);
    assert.deepEqual(
      (await search(f.signed.admin.cookie)).json().hits.map(hit => hit.citation.documentId),
      [privateOther.documentId],
    );
    await f.db.platform.query(`UPDATE ${f.table('tf_conversations')} SET is_closed=false WHERE id=$1`, [
      privateOwner.input.conversationId,
    ]);
    await check(ownCitation, f.signed.owner.cookie, 404);
    await check(sharedCitation, f.signed.owner.cookie, 200);
    await f.db.platform.query(`UPDATE ${f.table('tf_conversations')} SET deleted_at=clock_timestamp() WHERE id=$1`, [
      shared.input.conversationId,
    ]);
    await check(sharedCitation, f.signed.owner.cookie, 404);
    await check(otherCitation, f.signed.admin.cookie, 200);
  } finally {
    await f.close();
  }
});
