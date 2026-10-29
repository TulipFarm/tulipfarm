import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { shippedModelCatalogPath } from '@tulipfarm/config';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { creditSummary } from '@tulipfarm/workspace-storage/credits';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createAttachments } from '../../../packages/conversations/src/attachments.ts';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createFiles } from '../../../packages/files/src/index.ts';
import { png } from '../../../packages/memory-core/test/fixtures/parser-media.mjs';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { localWeb, send } from './local-web-fixture.mjs';
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
// Sonnet reads images for the workspace; Haiku answers without reading images, so its files are recognised, and draws
// with GPT Image.
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
    { ...model('claude-opus'), default: false },
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

// Content that must never reach telemetry: the prompt, a file name, recognised text and a link's query.
const sentinels = {
  prompt: 'SENTINELPROMPT tulips over a canal at dusk',
  filename: 'SENTINELNAME whiteboard.png',
  text: 'SENTINELTEXT ship on friday',
  query: 'SENTINELQUERY',
};
const sentinelPattern = /SENTINEL(PROMPT|NAME|TEXT|QUERY)/;

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

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test(
  'image generation, recognition and link reads record counts, sizes, types and outcomes, never content, and leave receipts',
  { timeout: 120000 },
  async t => {
    const board = await png(24, 16, '#36c');
    const chart = await png(32, 24, '#c33');
    const drawn = await png(16, 16, '#2a7');
    const linkPath = `/chart.png?token=${sentinels.query}`;
    await localWeb(t, { [`files.example.com${linkPath}`]: send(200, chart, { 'content-type': 'image/png' }) });
    const f = await conversationFixture();
    const keys = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'MODEL_CATALOG',
      'MODEL_CATALOG_FILE',
      'FEATURE_FLAG_IMAGES',
      'HUNTSMAN_ENDPOINT',
    ];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: 'synthetic-test-key',
      OPENAI_API_KEY: 'openai-test-key',
      MODEL_CATALOG: catalog,
      FEATURE_FLAG_IMAGES: 'true',
      // Huntsman turns link reads on; links are fetched directly, not through it.
      HUNTSMAN_ENDPOINT: 'https://huntsman.example.com',
    });
    delete process.env.MODEL_CATALOG_FILE;
    t.after(async () => {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await f.close();
    });

    const telemetry = captureTelemetry(t);
    const chat = [];
    const images = [];
    let recognitions = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (new URL(url).host === 'api.openai.com') {
        images.push(JSON.parse(options.body));
        // The first image is rejected with an error that quotes the prompt; the second is drawn.
        if (images.length === 1)
          return Response.json(
            { error: { code: 'invalid_value', message: `Cannot draw ${sentinels.prompt} right now` } },
            { status: 400 },
          );
        return Response.json({
          data: [{ b64_json: Buffer.from(drawn).toString('base64') }],
          usage: { input_tokens: 20, output_tokens: 4160 },
        });
      }
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Tulips'));
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      if (JSON.stringify(body.system ?? '').includes('You read one image')) {
        recognitions += 1;
        return Response.json(
          anthropicText(JSON.stringify({ status: 'ok', text: sentinels.text, description: 'A whiteboard' })),
        );
      }
      chat.push(body);
      return Response.json(
        chat.length === 1
          ? anthropicTools([
              { tool: 'images.generate', prompt: sentinels.prompt, count: 2, aspect: 'square', quality: 'standard' },
            ])
          : anthropicText('Here is your picture.'),
      );
    });

    const w = f.workspace;
    const attachmentBytes = memoryBytes();
    const files = createFiles(f.runtime, memoryBytes());
    const attachments = createAttachments(f.runtime, attachmentBytes);
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const attachmentId = randomUUID();
    await attachments.reserve(w.id, w.userId, chatId, attachmentId, {
      filename: sentinels.filename,
      mediaType: 'image/png',
      size: board.byteLength,
      sha256: sha256(board),
    });
    await attachments.upload(w.id, w.userId, chatId, attachmentId, board);
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-haiku',
      parts: [
        { kind: 'attachment', attachmentId },
        { kind: 'text', text: `Read this and https://files.example.com${linkPath} then draw tulips.` },
      ],
    });
    const status = await createConversationActivities(
      f.runtime,
      undefined,
      { attachments: attachmentBytes, snapshots: attachmentBytes },
      undefined,
      files,
    ).processConversationReply({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 });
    assert.equal(status, 'completed');

    // The turn ran as a user sees it: both images recognised, one image drawn and one failed.
    assert.equal(recognitions, 2);
    assert.match(JSON.stringify(chat[0].messages), new RegExp(sentinels.text));
    assert.deepEqual(
      images.map(body => body.prompt),
      [sentinels.prompt, sentinels.prompt],
    );
    const [result] = toolResults(chat.at(-1)).map(content => {
      const raw = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
      return JSON.parse(raw.replace(/^Untrusted tool result for [a-z.]+: /, ''));
    });
    assert.deepEqual(result.images.map(image => image.state).toSorted(), ['failed', 'saved']);

    // Nothing sent to telemetry carries the prompt, a file name, recognised text, a link's query or image bytes.
    const sent_ = telemetry.sent();
    assert.doesNotMatch(sent_, sentinelPattern);
    for (const bytes of [board, chart, drawn])
      assert.ok(!sent_.includes(Buffer.from(bytes).toString('base64').slice(0, 64)), 'no image bytes are sent');
    // The image and recognition spans never hold content even before the exporter's allowlist.
    const own = telemetry
      .raw()
      .filter(span => span.name.startsWith('image_generation ') || span.name === 'media.recognize');
    assert.doesNotMatch(JSON.stringify(own.map(span => span.attributes)), sentinelPattern);

    // What is recorded: counts, sizes, media types, outcomes and model ids.
    const exported = telemetry.exported();
    const generation = exported
      .filter(span => span.name === 'image_generation gpt-image-1')
      .map(span => span.attributes)
      .toSorted((a, b) => String(a.outcome).localeCompare(String(b.outcome)));
    assert.equal(generation.length, 2, exported.map(span => span.name).join(', '));
    const [failed, made] = generation;
    assert.deepEqual(
      {
        operation: made['gen_ai.operation.name'],
        provider: made['gen_ai.provider.name'],
        model: made['gen_ai.request.model'],
        outcome: made.outcome,
        media: made['media.outcome'],
        type: made['media.type'],
        bytes: made['media.bytes'],
        sources: made['media.sources'],
        quality: made['media.quality'],
        input: made['gen_ai.usage.input_tokens'],
        output: made['gen_ai.usage.output_tokens'],
      },
      {
        operation: 'image_generation',
        provider: 'openai',
        model: 'gpt-image-1',
        outcome: 'success',
        media: 'image',
        type: 'image/png',
        bytes: drawn.byteLength,
        sources: 0,
        quality: 'standard',
        input: 20,
        output: 4160,
      },
    );
    assert.equal(failed.outcome, 'error');
    assert.equal(failed['media.outcome'], 'failed');
    assert.equal(failed['http.response.status_code'], 400);
    const recognised = exported.filter(span => span.name === 'media.recognize').map(span => span.attributes);
    assert.deepEqual(
      recognised
        .map(span => ({
          kind: span['media.kind'],
          type: span['media.type'],
          bytes: typeof span['media.bytes'],
          outcome: span['media.outcome'],
        }))
        .toSorted(),
      [
        { kind: 'image', type: 'image/png', bytes: 'number', outcome: 'recognized' },
        { kind: 'image', type: 'image/png', bytes: 'number', outcome: 'recognized' },
      ],
    );
    // The provider's error is logged with the quoted prompt redacted.
    const failure = telemetry
      .logs()
      .find(line => line.event === 'call_failed' && line['gen_ai.operation.name'] === 'image_generation');
    assert.ok(failure, 'the failed image call is logged');
    assert.equal(failure['media.outcome'], 'failed');
    assert.match(failure['provider.error_message'], /\[text\]/);

    // Each recognition is a receipt: who asked, the model, the file, the unit's outcome and the attempt that charged it.
    const membership = (
      await f.db.platform.query(`SELECT id FROM ${f.table('tf_memberships')} WHERE user_id=$1`, [w.userId])
    ).rows[0].id;
    const receipts = (
      await f.db.platform.query(
        `SELECT r.flow_id,r.requester_kind,r.requester_id,r.source,r.model_id,r.unit_kind,r.media_type,r.outcome,
          r.media_sha256,o.charged::text AS charged
        FROM ${f.table('tf_recognition_receipts')} r
        JOIN ${f.table('tf_knowledge_credit_observations')} o ON o.attempt_id=r.credit_attempt_id
        ORDER BY r.source`,
      )
    ).rows;
    // A link in a message is kept as an attachment of it, so its receipt names that attachment, never the address.
    const linked = receipts.find(row => row.source !== `attachment:${attachmentId}`);
    assert.match(linked?.source ?? '', /^attachment:[0-9a-f-]{36}$/);
    const expected = (source, bytes) => ({
      flow_id: `chat:${chatId}:${sent.turnId}`,
      requester_kind: 'member',
      requester_id: membership,
      source,
      model_id: 'claude-sonnet',
      unit_kind: 'image',
      media_type: 'image/png',
      outcome: 'recognized',
      media_sha256: sha256(bytes),
      charged: true,
    });
    assert.deepEqual(
      receipts
        .map(({ charged, ...row }) => ({ ...row, charged: BigInt(charged) > 0n }))
        .toSorted((a, b) => (a.source === linked.source) - (b.source === linked.source)),
      [expected(`attachment:${attachmentId}`, board), expected(linked.source, chart)],
    );

    // Under the images flag the credits summary names image work as its own activities; without it, as before.
    const summary = images =>
      f.runtime.transaction(w.id, commonCompatibility, tx => creditSummary(tx, { kind: 'workspace', images }));
    const activities = breakdown =>
      Object.fromEntries(
        breakdown
          .filter(entry => entry.activity.startsWith('image-') || entry.activity === 'knowledge-ingestion')
          .map(entry => [entry.activity, entry.calls]),
      );
    assert.deepEqual(activities((await summary(true)).breakdown), { 'image-generation': 2, 'image-recognition': 2 });
    assert.deepEqual(activities((await summary(false)).breakdown), { 'knowledge-ingestion': 2 });
  },
);
