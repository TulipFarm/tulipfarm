import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { shippedModelCatalogPath } from '@tulipfarm/config';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { creditUnitsForProviderCost } from '@tulipfarm/workspace-storage/credits';
import { createFiles } from '../../../packages/files/src/index.ts';
import { png } from '../../../packages/memory-core/test/fixtures/parser-media.mjs';
import { promptFixture } from '../../../packages/slack/test/link-prompts.integration.mjs';
import { createSlackDirectMessages } from '../../../packages/slack/src/direct-messages.ts';
import { createConversationActivities } from '../src/conversation-activities.ts';
import {
  anthropicText,
  anthropicTools,
  completionReply,
  isCompletionRequest,
  isTitleRequest,
  toolResults,
} from './native-chat-fixture.mjs';
import { captureTelemetry } from './telemetry-capture.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const shipped = JSON.parse(readFileSync(shippedModelCatalogPath, 'utf8'));
const model = id => shipped.models.find(entry => entry.id === id);
// Haiku is a text-only family that draws with OpenAI, so a Slack image is recognised before the model sees it.
const catalog = JSON.stringify({
  ...shipped,
  models: [
    {
      ...model('claude-sonnet'),
      default: true,
      roles: [...model('claude-sonnet').roles, 'document-vision'],
      capabilities: { ...model('claude-sonnet').capabilities, imageInput: true },
    },
    {
      ...model('claude-haiku'),
      default: false,
      imageModel: 'gpt-image',
      limits: {
        maxInputTokens: model('claude-haiku').limits.maxInputTokens,
        maxOutputTokens: model('claude-haiku').limits.maxOutputTokens,
      },
      capabilities: { ...model('claude-haiku').capabilities, imageInput: false },
    },
  ],
  imageModels: [
    {
      id: 'gpt-image',
      name: 'GPT Image',
      vendor: 'openai',
      routes: [{ provider: 'openai', model: 'gpt-image-1', api: 'openai-images' }],
      edits: true,
      maxSources: 4,
      aspects: { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
      pricing: {
        usdPerImage: {
          standard: { square: 0.04, portrait: 0.06, landscape: 0.06 },
          high: { square: 0.16, portrait: 0.24, landscape: 0.24 },
        },
      },
    },
  ],
});
const sentinels = {
  prompt: 'SENTINELPROMPT tulips from the whiteboard plan',
  filename: 'SENTINELNAME board.png',
  text: 'SENTINELTEXT plant tulips in rows',
};
const fileUrl = 'https://files.slack.com/files-pri/TONE-F1/board.png';

/** Links the DM sender UPERSON to the workspace member and grants them the installation, as Slack linking does. */
async function authorizeDm(f) {
  const id = randomUUID();
  const credential = f.options.cipher.encrypt(
    {
      workspaceId: f.workspace.id,
      installationId: f.installationId,
      generation: 1,
      kind: 'user',
      identityId: id,
      membershipId: f.workspace.membershipId,
      slackUserId: 'UPERSON',
    },
    'synthetic-user-token',
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_slack_identities')} (id,installation_id,generation,slack_user_id,user_id,membership_id,state,credential,scopes) VALUES ($1,$2,1,'UPERSON',$3,$4,'authorized',$5,ARRAY['im:history'])`,
    [id, f.installationId, f.workspace.userId, f.workspace.membershipId, credential],
  );
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_slack_installation_grants')} (installation_id,membership_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [f.installationId, f.workspace.membershipId],
  );
}

function memoryBytes() {
  const objects = new Map();
  return {
    putIfAbsent: async (key, body) => {
      if (!objects.has(key)) objects.set(key, Buffer.from(body));
    },
    read: async key => Buffer.from(objects.get(key)),
    remove: async key => void objects.delete(key),
  };
}

test(
  'a Slack DM generates an image as chat does: saved in Files, held then charged, returned to the model',
  { timeout: 120000 },
  async t => {
    const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MODEL_CATALOG', 'MODEL_CATALOG_FILE', 'FEATURE_FLAG_IMAGES'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: 'synthetic-test-key',
      OPENAI_API_KEY: 'openai-test-key',
      MODEL_CATALOG: catalog,
      FEATURE_FLAG_IMAGES: 'true',
    });
    delete process.env.MODEL_CATALOG_FILE;
    const f = await promptFixture();
    t.after(async () => {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await f.close();
    });
    await f.db.platform.query(`UPDATE ${f.table('tf_slack_installations')} SET scopes=$1`, [
      ['chat:write', 'files:read'],
    ]);
    await authorizeDm(f);
    const board = Buffer.from(await png(24, 16, '#3a3'));
    const drawn = Buffer.from(await png(16, 16, '#a22'));
    const fetcher = async (url, init) => {
      if (new URL(url).hostname !== 'files.slack.com') return f.options.fetcher(url, init);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-bot-token');
      return new Response(board, { headers: { 'content-type': 'application/octet-stream' } });
    };
    const usage = () =>
      f.db.platform
        .query(
          `SELECT flow_id,activity,reserved::text,charged::text,provider_pico_usd::text FROM ${f.table('tf_credit_usage')} WHERE id LIKE 'image:%'`,
        )
        .then(result => result.rows);
    const chat = [];
    const images = [];
    let heldWhileDrawing;
    const script = [
      [{ tool: 'images.generate', prompt: sentinels.prompt, count: 1, aspect: 'square', quality: 'standard' }],
      'Here is your drawing.',
    ];
    const telemetry = captureTelemetry(t);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (new URL(url).host === 'api.openai.com') {
        images.push({ url: String(url), body: JSON.parse(options.body) });
        heldWhileDrawing = await usage();
        return Response.json({
          data: [{ b64_json: drawn.toString('base64') }],
          usage: { input_tokens: 20, output_tokens: 4160 },
        });
      }
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Tulips'));
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      if (JSON.stringify(body.system ?? '').includes('You read one image'))
        return Response.json(
          anthropicText(JSON.stringify({ status: 'ok', text: sentinels.text, description: 'A whiteboard' })),
        );
      chat.push(body);
      const next = script.shift() ?? 'Done.';
      return Response.json(typeof next === 'string' ? anthropicText(next) : anthropicTools(next));
    });

    const bytes = memoryBytes();
    const files = createFiles(f.runtime, memoryBytes());
    const dm = createSlackDirectMessages({
      ...f.options,
      fetcher,
      modelFamilyId: 'claude-haiku',
      files: { enabled: async () => true, bytes },
    });
    const eventId = await f.event('UPERSON', 'DONE', {
      text: 'Draw tulips from this plan',
      subtype: 'file_share',
      files: [{ id: 'F1', name: sentinels.filename, mimetype: 'image/png', url_private: fileUrl }],
    });
    const admission = await dm.admitPending(f.workspace.id);
    assert.deepEqual(admission.failures, []);
    for (const work of admission.files) await dm.admitFiles(work);
    const admitted = (
      await f.db.platform.query(
        `SELECT conversation_id,turn_id FROM ${f.table('tf_slack_dm_events')} WHERE event_id=$1`,
        [eventId],
      )
    ).rows[0];
    assert.ok(admitted, 'the direct message was admitted');
    const status = await createConversationActivities(
      f.runtime,
      undefined,
      { attachments: bytes, snapshots: bytes },
      undefined,
      files,
    ).processConversationReply({
      workspaceId: f.workspace.id,
      conversationId: admitted.conversation_id,
      turnId: admitted.turn_id,
      generation: 0,
    });
    assert.equal(status, 'completed');

    // The model read the Slack file as recognised text, then drew with the request chat sends.
    assert.match(JSON.stringify(chat[0].messages), new RegExp(sentinels.text));
    assert.deepEqual(images, [
      {
        url: 'https://api.openai.com/v1/images/generations',
        body: {
          model: 'gpt-image-1',
          prompt: sentinels.prompt,
          n: 1,
          size: '1024x1024',
          quality: 'medium',
          output_format: 'png',
        },
      },
    ]);

    // The tool result names the image saved in Files, whose bytes are the provider's.
    const [content] = toolResults(chat.at(-1));
    const text = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
    const result = JSON.parse(text.replace(/^Untrusted tool result for [a-z.]+: /, ''));
    assert.deepEqual(
      result.images.map(image => image.state),
      ['saved'],
    );
    const file = await files.download(f.workspace.id, f.workspace.userId, result.images[0].id);
    assert.equal(file.mediaType, 'image/png');
    assert.deepEqual(Buffer.from(file.bytes), drawn);
    const generations = (
      await f.db.platform.query(
        `SELECT id,origin_kind,origin_id,conversation_id,state,prompt,image_model_id FROM ${f.table('tf_image_generations')}`,
      )
    ).rows;
    assert.deepEqual(generations, [
      {
        id: result.images[0].id,
        origin_kind: 'turn',
        origin_id: admitted.turn_id,
        conversation_id: admitted.conversation_id,
        state: 'saved',
        prompt: sentinels.prompt,
        image_model_id: 'gpt-image',
      },
    ]);

    // Credits were held at the image's most before the provider answered, then charged at its $0.04 in the DM's chat.
    const reserved = creditUnitsForProviderCost(40000000000n).toString();
    assert.deepEqual(heldWhileDrawing, [
      {
        flow_id: admitted.conversation_id,
        activity: 'chat',
        reserved,
        charged: null,
        provider_pico_usd: null,
      },
    ]);
    const [settled] = await usage();
    assert.equal(settled.provider_pico_usd, '40000000000');
    assert.equal(settled.reserved, reserved);
    assert.notEqual(settled.charged, null);

    // Slack staging, recognition and generation leave no prompt, filename or file text in telemetry.
    assert.doesNotMatch(telemetry.sent(), /SENTINEL(PROMPT|NAME|TEXT)/);
    const own = telemetry
      .raw()
      .filter(span => span.name === 'media.recognize' || span.name.startsWith('image_generation'));
    assert.deepEqual(own.map(span => span.name).toSorted(), ['image_generation gpt-image-1', 'media.recognize']);
    assert.doesNotMatch(JSON.stringify(own.map(span => span.attributes)), /SENTINEL(PROMPT|NAME|TEXT)/);
  },
);
