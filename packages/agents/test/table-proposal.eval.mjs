// Measures how well a live model writes valid tables.propose payloads. Skipped unless TABLE_EVAL_MODEL is set.
//
//   pnpm exec turbo run build --filter=@tulipfarm/agents^...
//   TABLE_EVAL_MODEL=<catalog model id> TEST_ADMIN_DATABASE_URL=postgres://postgres:local-postgres@127.0.0.1:5432/postgres \
//     node --test packages/agents/test/table-proposal.eval.mjs
//
// Optional: TABLE_EVAL_REPETITIONS (default 3), TABLE_EVAL_MAX_REQUESTS (default and maximum 200),
// TABLE_EVAL_PROMPTS (comma-separated prompt IDs), TABLE_EVAL_LABEL, and TABLE_EVAL_OUT (default reports/table-proposal-eval).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { createChatTools, isExternalTool } from '../src/tools.ts';
import { inferWithTools } from '../src/inference.ts';
import { modelEnvironment } from '../src/model-environment.ts';

const family = process.env.TABLE_EVAL_MODEL;
const repetitions = Number(process.env.TABLE_EVAL_REPETITIONS ?? 3);
const maxRequests = Math.min(200, Number(process.env.TABLE_EVAL_MAX_REQUESTS ?? 200));
const maxRunRequests = 16;
const team = 'qa-eval-operations';
const readTools = new Set([
  'schema.context',
  'schema.inspect',
  'tables.list',
  'tables.definitions',
  'skills.list',
  'skills.read',
  'tables.propose',
]);
const suffix = `Owning team: ${team}. Use schema.context to find the team. Prepare one schema proposal for my approval; create no records and change no existing tables.`;
const tableEvalPrompts = [
  {
    id: 'todo',
    expectedKinds: ['text', 'boolean', 'date', 'single-select', 'multi-select', 'file'],
    tables: 1,
    text: 'Create a table "Eval Todo List". Fields: title (text, required, unique), done (boolean, required), due date (date), priority (single-select: Low, Medium, High, Urgent), tags (multi-select: Home, Work, Errands, Finance, Health), and attachments (files).',
  },
  {
    id: 'crm',
    expectedKinds: ['text', 'numeric', 'boolean', 'timestamp', 'single-select', 'relationship'],
    tables: 2,
    text: 'Create two linked tables for a CRM. "Eval Companies": name (text, required, unique), industry (single-select: Software, Retail, Healthcare, Finance, Manufacturing, Education, Logistics, Media, Energy, Hospitality, Agriculture, Government), employee count (whole number, up to 9 digits), and created at (date and time). "Eval Contacts": full name (text, required), email (text, required, unique), primary contact (boolean), and company (a link to exactly one company in Eval Companies).',
  },
  {
    id: 'invoice',
    expectedKinds: ['text', 'numeric', 'boolean', 'date', 'timestamp', 'single-select', 'file'],
    tables: 1,
    text: 'Create a table "Eval Invoices". Fields: invoice number (text, required, unique), issued on (date, required), due on (date), amount (money, 12 digits total with 2 decimal places, required), tax rate (decimal with 4 decimal places, at most 5 digits total), paid (boolean), paid at (date and time), status (single-select: Draft, Sent, Paid, Overdue, Void), and PDF (file).',
  },
  {
    id: 'leave',
    expectedKinds: ['text', 'numeric', 'boolean', 'date', 'timestamp', 'single-select', 'multi-select'],
    tables: 1,
    text: 'Create an HR leave tracker table "Eval Leave Requests". Fields: request code (text, required, unique), employee name (text, required), leave type (single-select: Annual, Sick, Parental, Unpaid, Bereavement, Study), start date and end date (dates, required), days requested (decimal with one decimal place, up to 999.5), approved (boolean), submitted at (date and time), and reasons (multi-select: Travel, Family, Medical, Personal, Other).',
  },
  {
    id: 'inventory',
    expectedKinds: ['text', 'numeric', 'timestamp', 'single-select', 'multi-select'],
    tables: 1,
    text: 'Create a table "Eval Inventory". Fields: SKU (text, required, unique), warehouse (single-select with 15 options: Mumbai, Delhi, Bengaluru, Chennai, Hyderabad, Pune, Kolkata, Ahmedabad, Jaipur, Lucknow, Kochi, Indore, Nagpur, Surat, Bhopal), categories (multi-select with 20 options: Electronics, Furniture, Apparel, Toys, Books, Kitchen, Garden, Sports, Beauty, Grocery, Office, Automotive, Pet, Baby, Tools, Music, Health, Jewelry, Footwear, Outdoor), unit price (12 digits with 2 decimal places), weight in kg (8 digits with 3 decimal places), and last counted at (date and time).',
  },
  {
    id: 'projects',
    expectedKinds: ['text', 'numeric', 'boolean', 'date', 'timestamp', 'single-select', 'multi-select', 'relationship'],
    tables: 2,
    text: 'Create two linked tables. "Eval Projects": project code (text, required, unique), name (text, required), status (single-select: Planned, Active, Paused, Done), and archived (boolean). "Eval Project Tasks": task title (text, required), project (a link to one project in Eval Projects, required), estimate hours (decimal with 2 decimal places, up to 9999.99), labels (multi-select: Bug, Feature, Chore, Research), due date (date), and completed at (date and time).',
  },
];

class BudgetExhausted extends Error {}

function proposalShape(raw) {
  try {
    const input = JSON.parse(raw);
    return (input.plans ?? []).map(plan => ({
      kind: plan.kind,
      fieldKinds: plan.target?.fields?.map(field => field.kind) ?? [],
      uniqueKeys: plan.target?.uniqueKeys?.length ?? 0,
    }));
  } catch {
    return null;
  }
}

function summarize(runs) {
  const done = runs.filter(run => !run.budgetExhausted);
  const proposed = done.filter(run => run.proposeCalls > 0);
  const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const issues = new Map();
  for (const run of done)
    for (const attempt of run.attempts)
      for (const issue of attempt.issues ?? []) {
        const key = `${issue.code}: ${issue.message ?? ''} @ ${issue.path?.map(p => (typeof p === 'number' ? '*' : p)).join('.')}`;
        issues.set(key, (issues.get(key) ?? 0) + 1);
      }
  return {
    runs: done.length,
    budgetExhausted: runs.length - done.length,
    firstAttemptValidPct: proposed.length
      ? (100 * proposed.filter(run => run.firstValid).length) / proposed.length
      : null,
    successPct: done.length ? (100 * done.filter(run => run.success).length) / done.length : null,
    meanRetries: mean(done.filter(run => run.success).map(run => run.callsBeforeSuccess - 1)),
    meanProposeCalls: mean(done.map(run => run.proposeCalls)),
    meanRequests: mean(done.map(run => run.requests)),
    meanInputTokens: mean(done.filter(run => run.usageKnown).map(run => run.inputTokens)),
    meanOutputTokens: mean(done.filter(run => run.usageKnown).map(run => run.outputTokens)),
    proposalInputSchemaBytes: [...new Set(done.map(run => run.proposalInputSchemaBytes).filter(Boolean))],
    skillReadBytes: [...new Set(done.map(run => run.skillReadBytes).filter(Boolean))],
    expectedKindCoveragePct: mean(done.filter(run => run.success).map(run => run.expectedKindCoveragePct)),
    topIssues: [...issues].sort((a, b) => b[1] - a[1]).slice(0, 20),
  };
}

test('live model table proposal evaluation', { skip: !family, timeout: 3600000 }, async t => {
  const route = modelEnvironment()?.route(family);
  assert.ok(route, 'Configure TABLE_EVAL_MODEL, the model catalog and its server credentials');
  const selected = process.env.TABLE_EVAL_PROMPTS?.split(',');
  const prompts = tableEvalPrompts.filter(prompt => !selected || selected.includes(prompt.id));
  assert.ok(prompts.length > 0, 'TABLE_EVAL_PROMPTS matched no prompt');
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace;
  const teamId = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,$2)`, [teamId, team]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')}(membership_id,team_id) VALUES($1,$2)`, [
    w.membershipId,
    teamId,
  ]);
  await f.db.platform.query(`UPDATE ${f.table('tf_soul_head')} SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);

  let totalRequests = 0;
  let current;
  const meter = async () => {
    if (totalRequests >= maxRequests) {
      current.budgetExhausted = !current.success;
      throw new BudgetExhausted(`Request cap ${maxRequests} reached`);
    }
    if (current.requests >= maxRunRequests) throw new Error(`Run request cap ${maxRunRequests} reached`);
    totalRequests++;
    current.requests++;
    return async usage => {
      if (usage.kind !== 'known') {
        current.usageKnown = false;
        return;
      }
      current.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite;
      current.outputTokens += usage.output;
    };
  };
  const executor = createConversationExecutor(f.runtime, async ({ messages, executeTool }) => {
    const answer = await inferWithTools(
      route,
      messages,
      async (call, activity) => {
        current.tools.push(call.tool);
        if (!readTools.has(call.tool))
          return {
            error: 'tool-unavailable',
            instruction: 'This evaluation only allows table discovery and proposals.',
          };
        const output = await executeTool(
          call.tool,
          isExternalTool(call.tool),
          context => createChatTools(context.runtime).invokeWithSources(context, call),
          [],
          call,
          activity,
        );
        const result = output.result;
        if (
          call.tool === 'skills.read' &&
          call.skillId === 'table-authoring' &&
          !call.resource &&
          result?.proposalInputSchema
        ) {
          current.skillReadBytes = Buffer.byteLength(JSON.stringify(result));
          current.proposalInputSchemaBytes = Buffer.byteLength(JSON.stringify(result.proposalInputSchema));
        }
        if (call.tool === 'tables.propose' && !current.success) {
          current.proposeCalls++;
          const valid = result?.status === 'pending';
          current.attempts.push({
            valid,
            inputBytes: Buffer.byteLength(call.input ?? ''),
            error: result?.error ?? null,
            status: result?.status ?? null,
            issues: result?.issues ?? null,
            shape: proposalShape(call.input),
          });
          if (current.proposeCalls === 1) current.firstValid = valid;
          if (valid) {
            current.success = true;
            current.callsBeforeSuccess = current.proposeCalls;
          }
        }
        return result;
      },
      meter,
    );
    return answer.text;
  });

  const runs = [];
  outer: for (let repetition = 0; repetition < repetitions; repetition++)
    for (const prompt of prompts) {
      current = {
        prompt: prompt.id,
        repetition,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        usageKnown: true,
        tools: [],
        proposeCalls: 0,
        firstValid: false,
        success: false,
        callsBeforeSuccess: null,
        attempts: [],
        skillReadBytes: null,
        proposalInputSchemaBytes: null,
        status: null,
        error: null,
        budgetExhausted: false,
      };
      runs.push(current);
      const chatId = randomUUID();
      try {
        await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
        const sent = await f.store.send(w.id, w.userId, chatId, {
          commandId: randomUUID(),
          messageId: randomUUID(),
          parts: [{ kind: 'text', text: `${prompt.text} ${suffix}` }],
        });
        current.status = await executor.process({
          workspaceId: w.id,
          conversationId: chatId,
          turnId: sent.turnId,
          generation: 0,
        });
      } catch (error) {
        current.error = String(error?.message ?? error).slice(0, 500);
      }
      const final = current.attempts.findLast(attempt => attempt.valid)?.shape;
      if (final) {
        const kinds = new Set(final.flatMap(plan => plan.fieldKinds));
        current.expectedKindCoveragePct =
          (100 * prompt.expectedKinds.filter(kind => kinds.has(kind)).length) / prompt.expectedKinds.length;
        current.tablesProposed = final.length;
      }
      process.stdout.write(
        `${prompt.id}#${repetition} success=${current.success} firstValid=${current.firstValid} propose=${current.proposeCalls} requests=${current.requests} tokens=${current.inputTokens}/${current.outputTokens}${current.error ? ` error=${current.error}` : ''}\n`,
      );
      if (totalRequests >= maxRequests) {
        process.stdout.write(`Request cap ${maxRequests} reached; stopping.\n`);
        break outer;
      }
    }

  const summary = summarize(runs);
  const report = {
    label: process.env.TABLE_EVAL_LABEL ?? null,
    model: family,
    provider: route.provider,
    repetitions,
    prompts: prompts.map(prompt => prompt.id),
    totalRequests,
    finishedAt: new Date().toISOString(),
    summary,
    runs,
  };
  const out = new URL(
    process.env.TABLE_EVAL_OUT ? `file://${process.env.TABLE_EVAL_OUT}/` : '../../../reports/table-proposal-eval/',
    import.meta.url,
  );
  await mkdir(out, { recursive: true });
  const file = new URL(
    `${(process.env.TABLE_EVAL_LABEL ?? 'run').replace(/[^\w.-]/g, '_')}-${family}-${Date.now()}.json`,
    out,
  );
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\nreport: ${file.pathname}\n`);
});
