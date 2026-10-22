import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connect, denied, fixture } from '../../workspace-storage/test/integration/fixture.mjs';

const digest = 'a'.repeat(64);
const batch = 'c'.repeat(64);

test('social storage keeps decisions, revisions and receipts out of the runtime role’s reach', async t => {
  const db = await fixture();
  const ws = await db.create();
  const runtime = await connect(db.login(ws));
  const confirmation = await connect(db.login(ws, 'confirmation'));
  const table = name => `${ws.names.schema}.${name}`;
  const member = ws.membershipId;
  const ids = {
    app: randomUUID(),
    account: randomUUID(),
    channel: randomUUID(),
    post: randomUUID(),
    variant: randomUUID(),
  };
  const decide = (revision, id = randomUUID(), decision = 'approve', client = confirmation) =>
    client.query(
      `INSERT INTO ${table('tf_social_decisions')} (id,post_id,revision,content_digest,batch_digest,decision,decider_membership_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, ids.post, revision, digest, batch, decision, member],
    );
  const addRevision = number =>
    runtime.query(
      `INSERT INTO ${table('tf_social_revisions')} (post_id,number,content_digest,payload,sources,mcp_derived,private_task_derived,expires_at)
       VALUES ($1,$2,$3,'{}','{"dependencies":[]}',false,false,clock_timestamp()+interval '1 day')`,
      [ids.post, number, digest],
    );
  const addChannel = (id, platformChannelId, kind = 'x-account') =>
    runtime.query(
      `INSERT INTO ${table('tf_social_channels')} (id,account_id,platform,channel_kind,platform_channel_id,display_name,account_generation) VALUES ($1,$2,'x',$3,$4,'T',1)`,
      [id, ids.account, kind, platformChannelId],
    );
  const addVariant = (id, revision, state = 'awaiting-approval', channel = ids.channel) =>
    runtime.query(
      `INSERT INTO ${table('tf_social_variants')} (id,post_id,revision,channel_id,channel_version,content,state)
       VALUES ($1,$2,$3,$4,1,'{"platform":"x","text":"hi","media":[],"replySettings":"everyone"}',$5)`,
      [id, ids.post, revision, channel, state],
    );
  const setState = (id, set) => runtime.query(`UPDATE ${table('tf_social_variants')} SET ${set} WHERE id=$1`, [id]);
  const receipt = (variant, revision, decisionId) =>
    runtime.query(
      `INSERT INTO ${table('tf_social_receipts')} (id,variant_id,revision,decision_id,step,attempt_id) VALUES ($1,$2,$3,$4,'create-post',$5) RETURNING id`,
      [randomUUID(), variant, revision, decisionId, randomUUID()],
    );
  const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message), String(pattern));
  try {
    await t.test('runtime seeds an app, account, channel, post, revision and variant', async () => {
      await runtime.query(
        `INSERT INTO ${table('tf_social_platform_apps')} (id,platform,name,client_id,client_secret,access_tier,created_by) VALUES ($1,'x','Ours','cid','{"sealed":"x"}','paid',$2)`,
        [ids.app, member],
      );
      await runtime.query(
        `INSERT INTO ${table('tf_social_accounts')} (id,platform,ownership,owner_membership_id,app_source,platform_app_id,app_generation,state,identity,credential)
         VALUES ($1,'x','personal',$2,'workspace',$3,1,'active','{"platformUserId":"1"}','{"sealed":"t"}')`,
        [ids.account, member, ids.app],
      );
      await addChannel(ids.channel, '1');
      await runtime.query(
        `INSERT INTO ${table('tf_social_channel_grants')} (channel_id,permission,membership_id) VALUES ($1,'manage',$2),($1,'publish',$2)`,
        [ids.channel, member],
      );
      await runtime.query(
        `INSERT INTO ${table('tf_social_posts')} (id,command_id,origin,author_membership_id) VALUES ($1,$2,$3,$4)`,
        [ids.post, randomUUID(), { kind: 'task', taskId: randomUUID(), generation: 0 }, member],
      );
      await addRevision(1);
      await addVariant(ids.variant, 1);
      await rejects(addChannel(randomUUID(), '2', 'facebook-page'), /check constraint/);
      await rejects(addChannel(randomUUID(), '1'), /duplicate key/);
    });

    await t.test('runtime cannot decide, rewrite revisions, delete receipts or skip approval', async () => {
      await denied(
        runtime,
        `INSERT INTO ${table('tf_social_decisions')} (id,post_id,revision,content_digest,batch_digest,decision,decider_membership_id) VALUES ($1,$2,1,$3,$4,'approve',$5)`,
        [randomUUID(), ids.post, digest, batch, member],
      );
      await denied(runtime, `UPDATE ${table('tf_social_revisions')} SET payload='{}'`);
      await denied(runtime, `UPDATE ${table('tf_social_revisions')} SET content_digest=$1`, ['b'.repeat(64)]);
      await denied(runtime, `UPDATE ${table('tf_social_decisions')} SET batch_digest=$1`, ['b'.repeat(64)]);
      await denied(runtime, `DELETE FROM ${table('tf_social_revisions')}`);
      await denied(runtime, `DELETE FROM ${table('tf_social_receipts')}`);
      await denied(runtime, `DELETE FROM ${table('tf_social_decisions')}`);
      await denied(runtime, `UPDATE ${table('tf_social_decisions')} SET decision='approve'`);
      await denied(runtime, `DELETE FROM ${table('tf_social_variants')}`);
      await denied(runtime, `UPDATE ${table('tf_social_variants')} SET content='{}'`);
      await denied(runtime, `UPDATE ${table('tf_social_receipts')} SET decision_id=$1`, [randomUUID()]);
      await denied(
        runtime,
        `INSERT INTO ${table('tf_social_engagement_decisions')} (id,action_id,digest,decision,decider_membership_id) VALUES ($1,$2,$3,'approve',$4)`,
        [randomUUID(), randomUUID(), digest, member],
      );
      await rejects(setState(ids.variant, "state='scheduled', due_at=clock_timestamp()"), /approved revision/);
      await rejects(addVariant(randomUUID(), 1, 'scheduled'), /start before approval/);
      await denied(confirmation, `SELECT credential FROM ${table('tf_social_accounts')}`);
      await denied(
        confirmation,
        `INSERT INTO ${table('tf_social_posts')} (id,command_id,origin,author_membership_id) VALUES ($1,$1,'{"kind":"task"}',$2)`,
        [randomUUID(), member],
      );
    });

    let decisionId;
    await t.test('the confirmation role records the decision, then runtime schedules and sends', async () => {
      decisionId = randomUUID();
      await rejects(
        confirmation.query(
          `INSERT INTO ${table('tf_social_decisions')} (id,post_id,revision,content_digest,batch_digest,decision,decider_membership_id) VALUES ($1,$2,1,$3,$4,'approve',$5)`,
          [randomUUID(), ids.post, 'b'.repeat(64), batch, member],
        ),
        /foreign key/,
      );
      await rejects(
        confirmation.query(
          `INSERT INTO ${table('tf_social_decisions')} (id,post_id,revision,content_digest,batch_digest,decision,decider_membership_id) VALUES ($1,$2,1,$3,'XYZ','approve',$4)`,
          [randomUUID(), ids.post, digest, member],
        ),
        /check constraint/,
      );
      await decide(1, decisionId);
      await setState(ids.variant, "state='scheduled', due_at=clock_timestamp()");
      await rejects(
        setState(ids.variant, "state='published', platform_post_id='p0'"),
        /cannot move from scheduled to published/,
      );
      const sending = step =>
        setState(
          ids.variant,
          `state='sending', attempt_id=gen_random_uuid(), next_attempt_at=clock_timestamp()+interval '5 minutes', step='${step}'`,
        );
      for (const step of [
        '{"kind":"create-post","mode":"mutate"}',
        '{"index":-1,"kind":"create-post"}',
        '{"index":0.5,"kind":"create-post"}',
        '{"index":"0","kind":"create-post"}',
        '{"index":0,"kind":"publish"}',
        '{"index":0,"kind":"create-post","mode":"mutate"}',
      ])
        await rejects(sending(step), /check constraint/);
      await sending('{"index":0,"kind":"create-post"}');
      await rejects(setState(ids.variant, "state='superseded'"), /cannot move from sending to superseded/);
      const { rows } = await receipt(ids.variant, 1, decisionId);
      await runtime.query(
        `UPDATE ${table('tf_social_receipts')} SET status='succeeded', settled_at=clock_timestamp(), platform_post_id='p1', platform_request_id='req-1' WHERE id=$1`,
        [rows[0].id],
      );
      await rejects(
        runtime.query(
          `UPDATE ${table('tf_social_receipts')} SET status='failed', error_class='rejected', error_code='x' WHERE id=$1`,
          [rows[0].id],
        ),
        /terminal/,
      );
      await setState(ids.variant, "state='published', platform_post_id='p1', permalink='https://x.com/i/status/p1'");
      await rejects(setState(ids.variant, "state='cancelled'"), /final/);
      await rejects(receipt(ids.variant, 2, decisionId), /approved revision/);
    });

    await t.test('variants with a receipt cannot be superseded or cancelled', async () => {
      await addRevision(2);
      await runtime.query(`UPDATE ${table('tf_social_posts')} SET current_revision=2 WHERE id=$1`, [ids.post]);
      const fresh = randomUUID();
      const attempted = randomUUID();
      const blocked = randomUUID();
      for (const [index, id] of [fresh, attempted, blocked].entries()) {
        const channel = index === 0 ? ids.channel : randomUUID();
        if (index > 0) await addChannel(channel, `c${index}`);
        await addVariant(id, 2, 'awaiting-approval', channel);
      }
      await rejects(addVariant(randomUUID(), 2), /duplicate key/);
      const second = randomUUID();
      await decide(2, second);
      for (const id of [attempted, blocked]) {
        await setState(id, "state='scheduled', due_at=clock_timestamp()");
        await receipt(id, 2, second);
      }
      await setState(
        blocked,
        "state='blocked', blocked_reason='daily-cap', recheck_at=clock_timestamp()+interval '1 hour'",
      );
      await rejects(setState(attempted, "state='superseded'"), /attempted step/);
      await rejects(setState(attempted, "state='cancelled'"), /attempted step/);
      await rejects(setState(blocked, "state='scheduled', blocked_reason=NULL, recheck_at=NULL"), /attempted step/);
      await setState(
        blocked,
        'state=\'processing\', blocked_reason=NULL, recheck_at=NULL, step=\'{"index":1,"kind":"await"}\'',
      );
      await setState(blocked, "state='blocked', blocked_reason='grant-removed'");
      await setState(blocked, "state='cancelled', blocked_reason=NULL, recheck_at=NULL");
      await setState(fresh, "state='superseded'");
      await rejects(
        setState(attempted, "state='blocked', blocked_reason='grant-removed', recheck_at=clock_timestamp()"),
        /check constraint/,
      );
      await rejects(decide(2), /duplicate key/);
    });

    await t.test('a blocked variant without an attempted step resumes to scheduled, never to processing', async () => {
      await addRevision(3);
      const unattempted = randomUUID();
      const channel = randomUUID();
      await addChannel(channel, 'c3');
      await addVariant(unattempted, 3, 'awaiting-approval', channel);
      await decide(3);
      await setState(unattempted, "state='scheduled', due_at=clock_timestamp()");
      await setState(
        unattempted,
        "state='blocked', blocked_reason='rate-limited', recheck_at=clock_timestamp()+interval '1 minute'",
      );
      await rejects(
        setState(unattempted, "state='processing', blocked_reason=NULL, recheck_at=NULL"),
        /no attempted step/,
      );
      await setState(unattempted, "state='scheduled', blocked_reason=NULL, recheck_at=NULL");
      await setState(unattempted, "state='superseded'");
    });

    await t.test('engagement actions need an approval from the confirmation role when required', async () => {
      const action = randomUUID();
      await runtime.query(
        `INSERT INTO ${table('tf_social_engagement_actions')} (id,channel_id,channel_version,membership_id,command_id,kind,in_reply_to,text,digest,sources,approval_required,state)
         VALUES ($1,$2,1,$3,$4,'reply','c1','Thanks',$5,'{}',true,'prepared')`,
        [action, ids.channel, member, randomUUID(), digest],
      );
      const update = set =>
        runtime.query(`UPDATE ${table('tf_social_engagement_actions')} SET ${set} WHERE id=$1`, [action]);
      await update("state='awaiting-approval'");
      await rejects(update("state='approved'"), /requires approval/);
      await denied(runtime, `UPDATE ${table('tf_social_engagement_actions')} SET text='changed'`);
      const engagementDecision = id =>
        confirmation.query(
          `INSERT INTO ${table('tf_social_engagement_decisions')} (id,action_id,digest,decision,decider_membership_id) VALUES ($1,$2,$3,'approve',$4)`,
          [id, action, digest, member],
        );
      await rejects(
        confirmation.query(
          `INSERT INTO ${table('tf_social_engagement_decisions')} (id,action_id,digest,decision,decider_membership_id) VALUES ($1,$2,$3,'approve',$4)`,
          [randomUUID(), action, 'b'.repeat(64), member],
        ),
        /foreign key/,
      );
      await engagementDecision(randomUUID());
      await rejects(engagementDecision(randomUUID()), /duplicate key/);
      await update("state='approved'");
      await rejects(
        update(
          "state='sending', attempt_id=gen_random_uuid(), lease_until=clock_timestamp()+interval '1 minute', receipt_status='executing', receipt_started_at=clock_timestamp(), error_class='rejected', error_code='x'",
        ),
        /check constraint/,
      );
      await update(
        "state='sending', attempt_id=gen_random_uuid(), lease_until=clock_timestamp()+interval '1 minute', receipt_status='executing', receipt_started_at=clock_timestamp()",
      );
      await update(
        "state='sent', receipt_status='succeeded', receipt_settled_at=clock_timestamp(), platform_id='r1', platform_request_id='req-3'",
      );
    });

    await t.test('runtime stores analytics snapshots and reschedules them', async () => {
      const id = randomUUID();
      await runtime.query(
        `INSERT INTO ${table('tf_social_analytics_snapshots')} (id,channel_id,variant_id,metrics,next_check_at) VALUES ($1,$2,$3,'[]',clock_timestamp())`,
        [id, ids.channel, ids.variant],
      );
      await runtime.query(
        `UPDATE ${table('tf_social_analytics_snapshots')} SET next_check_at=clock_timestamp()+interval '1 day' WHERE id=$1`,
        [id],
      );
      await denied(runtime, `UPDATE ${table('tf_social_analytics_snapshots')} SET metrics='[]'`);
      await runtime.query(`DELETE FROM ${table('tf_social_analytics_snapshots')} WHERE id=$1`, [id]);
    });
  } finally {
    await runtime.end();
    await confirmation.end();
    await db.close();
  }
});
