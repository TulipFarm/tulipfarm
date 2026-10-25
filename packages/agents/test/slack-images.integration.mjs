import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { png } from '../../memory-core/test/fixtures/parser-media.mjs';
import { outboundFixture } from './slack-actions-fixture.mjs';

/** Runs a test with the `images` flag set for every workspace. */
function withImages(t, on) {
  const previous = process.env.FEATURE_FLAG_IMAGES;
  process.env.FEATURE_FLAG_IMAGES = String(on);
  t.after(() => {
    if (previous === undefined) delete process.env.FEATURE_FLAG_IMAGES;
    else process.env.FEATURE_FLAG_IMAGES = previous;
  });
}

/**
 * Alice's delegated run on the HR agent, which saved one generated image per entry of `shares` in Files before it asked
 * to post to #hr. Each image is alice's file; `shares[i]` says whether bob may read image i, `names[i]` names it.
 */
async function imageRun(f, { shares, names = [], scopes = ['chat:write', 'im:write', 'files:read', 'files:write'] }) {
  await f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET scopes=$1 WHERE id=$2`, [
    scopes,
    f.installationId,
  ]);
  const queued = await f.queue();
  const images = [];
  for (const [ordinal, bobReads] of shares.entries()) {
    const id = randomUUID(),
      bytes = Buffer.from(await png(8 + ordinal, 6, ordinal ? '#a27' : '#2a7')),
      name = names[ordinal] ?? `poster-${ordinal + 1}.png`;
    await f.imageFiles.upload(
      f.workspace.id,
      f.alice.userId,
      id,
      { name, parentId: null, mediaType: 'image/png' },
      bytes,
    );
    if (bobReads)
      await f.imageFiles.share(
        f.workspace.id,
        f.alice.userId,
        id,
        { kind: 'individual', id: f.bob.membershipId },
        'viewer',
      );
    // Saved a minute ago, so before the Slack message was asked for.
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_image_generations')} (id,origin_kind,origin_id,call_hash,ordinal,creator_membership_id,state,prompt,image_model_id,created_at,updated_at)
      VALUES ($1,'run',$2,$3,$4,$5,'saved','A PRIVATE poster prompt','gpt-image',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute')`,
      // One images.generate call makes at most four images.
      [
        id,
        queued.ids.runId,
        createHash('sha256')
          .update(String(Math.floor(ordinal / 4)))
          .digest('hex'),
        ordinal % 4,
        f.alice.membershipId,
      ],
    );
    images.push({ id, name, bytes });
  }
  return { ...queued, images };
}

const bot = 'Bearer xoxb-fixture';

/**
 * Marks a call of the run completed. A delegated run refuses a Slack action while an earlier call of the run is not
 * completed, so this stands in for a run that may post again after a draft failed, or post twice at once.
 */
const completeCall = (f, callId) =>
  f.db.platform.query(`UPDATE ${f.table('tf_agent_tool_calls')} SET status='completed' WHERE id=$1`, [callId]);

test('a run that saved two images delivers both as files in the thread of its message', async t => {
  withImages(t, true);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    const { ids, images } = await imageRun(f, { shares: [true, true] });
    assert.equal(await f.executor.execute(ids), 'completed');
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxp-alice', name: 'send', channel: 'CHR', text: 'Approved HR update' },
    ]);
    assert.deepEqual(
      f.files.map(call => [call.token, call.method]),
      [
        [bot, 'files.getUploadURLExternal'],
        [bot, 'files.getUploadURLExternal'],
        [bot, 'files.completeUploadExternal'],
      ],
    );
    assert.deepEqual(
      f.files.slice(0, 2).map(call => call.params),
      images.map(image => ({ filename: image.name, length: String(image.bytes.byteLength) })),
    );
    // Both files are shared in one message under the delivered message (the fake Slack answers ts 6.000001).
    assert.deepEqual(f.files[2].params, {
      files: JSON.stringify([
        { id: 'F0001', title: 'poster-1.png' },
        { id: 'F0002', title: 'poster-2.png' },
      ]),
      channel_id: 'CHR',
      thread_ts: '6.000001',
    });
    assert.deepEqual(
      f.uploads.map(upload => upload.path),
      ['/upload/v1/U1', '/upload/v1/U2'],
    );
    for (const [index, upload] of f.uploads.entries()) {
      assert.equal(upload.headers.authorization, undefined);
      assert.equal(upload.headers['content-type'], 'application/octet-stream');
      assert.equal(
        createHash('sha256').update(upload.bytes).digest('hex'),
        createHash('sha256').update(images[index].bytes).digest('hex'),
      );
    }
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, ids.callId)).status, 'sent');
  } finally {
    await f.close();
  }
});

test('an image someone in the destination cannot read in Files is withheld and only counted in the thread', async t => {
  withImages(t, true);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    // Generated images are named after their prompt, so the withheld one's name must not reach Slack.
    const { ids, images } = await imageRun(f, {
      shares: [true, false],
      names: ['poster-1.png', 'Salary bands for the CONFIDENTIAL reorg.png'],
    });
    const lines = [];
    const write = process.stdout.write.bind(process.stdout);
    t.mock.method(process.stdout, 'write', (chunk, ...rest) => {
      lines.push(String(chunk));
      return write(chunk, ...rest);
    });
    assert.equal(await f.executor.execute(ids), 'completed');
    t.mock.restoreAll();
    // Logs carry no file names or prompts.
    assert.doesNotMatch(lines.join(''), /poster-|PRIVATE|CONFIDENTIAL/);
    assert.deepEqual(
      f.files.map(call => call.method),
      ['files.getUploadURLExternal', 'files.completeUploadExternal'],
    );
    assert.equal(f.files[0].params.filename, 'poster-1.png');
    assert.equal(f.uploads.length, 1);
    assert.deepEqual(f.uploads[0].bytes, images[0].bytes);
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxp-alice', name: 'send', channel: 'CHR', text: 'Approved HR update' },
      {
        token: bot,
        name: 'reply',
        channel: 'CHR',
        ts: '6.000001',
        text: 'An image from this run is in TulipFarm Files and was not attached here.',
      },
    ]);
    assert.equal(f.bodies.filter(body => body.includes('CONFIDENTIAL')).length, 0);
    assert.equal(f.bodies.filter(body => body.includes('poster-1.png')).length, 2);
  } finally {
    await f.close();
  }
});

test('a guest or another app in the destination withholds every image', async t => {
  withImages(t, true);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UGUEST', 'BOTHERBOT', 'UBOT']);
    const { ids } = await imageRun(f, { shares: [true, true] });
    assert.equal(await f.executor.execute(ids), 'completed');
    assert.deepEqual(f.files, []);
    assert.deepEqual(f.uploads, []);
    assert.equal(f.effects.length, 2);
    assert.equal(f.effects[1].text, '2 images from this run are in TulipFarm Files and were not attached here.');
    assert.equal(f.bodies.filter(body => body.includes('poster-')).length, 0);
  } finally {
    await f.close();
  }
});

test('without files:write the message is delivered, nothing is uploaded and the thread names the images', async t => {
  withImages(t, true);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    const { ids } = await imageRun(f, { shares: [true, true], scopes: ['chat:write', 'im:write', 'files:read'] });
    assert.equal(await f.executor.execute(ids), 'completed');
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, ids.callId)).status, 'sent');
    assert.deepEqual(f.files, []);
    assert.deepEqual(f.uploads, []);
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxp-alice', name: 'send', channel: 'CHR', text: 'Approved HR update' },
      {
        token: bot,
        name: 'reply',
        channel: 'CHR',
        ts: '6.000001',
        text: '2 images from this run are in TulipFarm Files and were not attached here: poster-1.png, poster-2.png',
      },
    ]);
  } finally {
    await f.close();
  }
});

test('a delivery retried after Slack throttled it uploads each image once', async t => {
  withImages(t, true);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    const { ids, call } = await imageRun(f, { shares: [true, true] });
    f.setMode('retry');
    assert.equal(await f.executor.execute(ids), 'waiting');
    assert.equal((await f.service.read(f.workspace.id, f.alice.userId, ids.callId)).status, 'retry');
    assert.deepEqual(f.files, []);
    f.setMode('success');
    await f.db.platform.query(
      `UPDATE ${f.table('tf_slack_action_effects')} SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE action_id=$1`,
      [ids.callId],
    );
    assert.equal(await f.executor.execute(ids), 'completed');
    assert.equal(f.uploads.length, 2);
    // Running the same delivery again finds the message sent and shares nothing more.
    assert.equal((await f.service.execute(f.workspace.id, ids.runId, ids.callId, call)).status, 'sent');
    assert.equal(await f.executor.execute(ids), 'completed');
    assert.equal(f.uploads.length, 2);
    assert.equal(f.files.filter(call => call.method === 'files.completeUploadExternal').length, 1);
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test('a rejected draft leaves the images to the next message the run sends', async t => {
  withImages(t, true);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    await f.legacyApproval();
    const { ids } = await imageRun(f, { shares: [true, true] });
    assert.equal(await f.executor.execute(ids), 'waiting');
    const draft = await f.service.read(f.workspace.id, f.alice.userId, ids.callId);
    await f.decide(f.workspace.id, f.alice.userId, ids.callId, { digest: draft.digest, decision: 'reject' });
    assert.equal(await f.executor.execute(ids), 'failed');
    assert.deepEqual(f.uploads, []);
    await completeCall(f, ids.callId);
    await f.legacyApproval(false);
    const next = { ...ids, callId: randomUUID() };
    await f.executor.queueCall(
      f.workspace.id,
      { kind: 'human', ...f.alice },
      {
        runId: ids.runId,
        callId: next.callId,
        sequence: 1,
        call: { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Revised HR update' },
      },
    );
    assert.equal(await f.executor.execute(next), 'completed');
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxp-alice', name: 'send', channel: 'CHR', text: 'Revised HR update' },
    ]);
    assert.deepEqual(
      f.files.filter(call => call.method === 'files.getUploadURLExternal').map(call => call.params.filename),
      ['poster-1.png', 'poster-2.png'],
    );
  } finally {
    await f.close();
  }
});

test('two messages of one run sent at once never share the same image', async t => {
  withImages(t, true);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    const { ids, call, images } = await imageRun(f, { shares: [true, true, true] });
    const other = { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Second HR update' },
      otherId = randomUUID();
    await completeCall(f, ids.callId);
    await f.executor.queueCall(
      f.workspace.id,
      { kind: 'human', ...f.alice },
      { runId: ids.runId, callId: otherId, sequence: 1, call: other },
    );
    const sent = await Promise.all([
      f.service.execute(f.workspace.id, ids.runId, ids.callId, call),
      f.service.execute(f.workspace.id, ids.runId, otherId, other),
    ]);
    assert.deepEqual(
      sent.map(action => action.status),
      ['sent', 'sent'],
    );
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.deepEqual(
      f.uploads.map(upload => digest(upload.bytes)).sort(),
      images.map(image => digest(image.bytes)).sort(),
    );
  } finally {
    await f.close();
  }
});

test('a message carries at most eight images and counts the rest in the thread', async t => {
  withImages(t, true);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    const { ids } = await imageRun(f, { shares: Array(10).fill(true) });
    assert.equal(await f.executor.execute(ids), 'completed');
    assert.deepEqual(
      f.files.filter(call => call.method === 'files.getUploadURLExternal').map(call => call.params.filename),
      [
        'poster-1.png',
        'poster-2.png',
        'poster-3.png',
        'poster-4.png',
        'poster-5.png',
        'poster-6.png',
        'poster-7.png',
        'poster-8.png',
      ],
    );
    assert.deepEqual(f.effects.slice(1), [
      {
        token: bot,
        name: 'reply',
        channel: 'CHR',
        ts: '6.000001',
        text: '2 images from this run are in TulipFarm Files and were not attached here.',
      },
    ]);
  } finally {
    await f.close();
  }
});

test('a second message of the same run does not share the images again', async t => {
  withImages(t, true);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    const { ids } = await imageRun(f, { shares: [true] });
    assert.equal(await f.executor.execute(ids), 'completed');
    const next = { ...ids, callId: randomUUID() };
    await f.executor.queueCall(
      f.workspace.id,
      { kind: 'human', ...f.alice },
      {
        runId: ids.runId,
        callId: next.callId,
        sequence: 1,
        call: { tool: 'slack.message.send', destinationId: f.destinationId, text: 'Follow-up' },
      },
    );
    assert.equal(await f.executor.execute(next), 'completed');
    assert.equal(f.effects.length, 2);
    assert.equal(f.uploads.length, 1);
  } finally {
    await f.close();
  }
});

test('with images off, delivery is unchanged', async t => {
  withImages(t, false);
  const f = await outboundFixture({ images: true });
  try {
    f.setAudience(['UALICE', 'UBOB', 'UBOT']);
    const { ids } = await imageRun(f, { shares: [true, true] });
    assert.equal(await f.executor.execute(ids), 'completed');
    assert.deepEqual(f.effects, [
      { token: 'Bearer xoxp-alice', name: 'send', channel: 'CHR', text: 'Approved HR update' },
    ]);
    assert.deepEqual(f.files, []);
    assert.deepEqual(f.uploads, []);
  } finally {
    await f.close();
  }
});
