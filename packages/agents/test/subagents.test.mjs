import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import {
  boundSubagentResult,
  childCreditBudget,
  createSubagentPool,
  helperToolGrant,
  runSubagents,
} from '../src/subagents.ts';
import { delegateCallSchema, delegatedRequestId, subagentLimits } from '../src/subagent-contracts.ts';
import { createChatTools, discoverToolNames } from '../src/tools.ts';

const helper = (name, extra = {}) => ({
  kind: 'helper',
  name,
  role: 'Researcher',
  task: `Research ${name}`,
  tools: ['web.search'],
  ...extra,
});
const call = (agents, timeLimitSeconds) => ({
  tool: 'agents.delegate',
  agents,
  ...(timeLimitSeconds ? { timeLimitSeconds } : {}),
});

/** A manual clock: timers fire only when the test calls `fire`. */
function manualTimers() {
  const timers = new Set();
  return {
    setTimer(callback, ms) {
      const timer = { callback, ms };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    fire() {
      const due = Array.from(timers);
      timers.clear();
      for (const timer of due) timer.callback();
    },
    get size() {
      return timers.size;
    },
  };
}

/** Resolves once `signal` aborts, after recording interim text, like a runner cut off mid-work. */
const untilAborted = (partial, step) => (_spec, live) => {
  if (step) live.progress.step(step);
  if (partial) live.progress.text(partial);
  return new Promise((_, reject) => live.signal.addEventListener('abort', () => reject(live.signal.reason)));
};

function input(overrides = {}) {
  const published = [];
  return {
    published,
    value: {
      call: call([helper('Alpha')]),
      depth: 0,
      pool: createSubagentPool(),
      signal: new AbortController().signal,
      run: async () => 'Report',
      publish: cards => published.push(cards),
      resultBytes: 100_000,
      ...overrides,
    },
  };
}

test('delegation runs every sub-agent in parallel and returns each report with the credits they used', async () => {
  let running = 0;
  let peak = 0;
  const { value, published } = input({
    call: call([helper('Alpha'), helper('Beta'), helper('Gamma')]),
    run: async (spec, live) => {
      running++;
      peak = Math.max(peak, running);
      live.progress.step('Searching the web');
      live.progress.credits(spec.name === 'Alpha' ? 1.5 : 0.25);
      await new Promise(resolve => setImmediate(resolve));
      running--;
      return `${spec.name} findings`;
    },
  });
  const result = await runSubagents(value);
  assert.equal(peak, 3);
  assert.deepEqual(
    result.agents.map(agent => [agent.key, agent.kind, agent.name, agent.status, agent.credits, agent.report]),
    [
      ['a0', 'helper', 'Alpha', 'done', 1.5, 'Alpha findings'],
      ['a1', 'helper', 'Beta', 'done', 0.25, 'Beta findings'],
      ['a2', 'helper', 'Gamma', 'done', 0.25, 'Gamma findings'],
    ],
  );
  assert.equal(result.totalCredits, 2);
  assert.ok(result.agents.every(agent => !('step' in agent)));
  assert.equal(value.pool.active, 0);
  assert.ok(published.some(cards => cards.some(card => card.step === 'Searching the web')));
  assert.deepEqual(
    published.at(-1).map(card => card.status),
    ['done', 'done', 'done'],
  );
});

test('delegation refuses past the depth limit and the concurrent child limit', async () => {
  const deep = await runSubagents(input({ depth: subagentLimits.depth }).value);
  assert.equal(deep.error, 'delegation-depth');

  const pool = createSubagentPool();
  assert.equal(pool.acquire(4), true);
  const full = await runSubagents(input({ pool, call: call([helper('Alpha'), helper('Beta')]) }).value);
  assert.equal(full.error, 'delegation-limit');
  assert.equal(pool.active, 4);
  pool.release(4);
  assert.equal((await runSubagents(input({ pool, call: call([helper('Alpha')]) }).value)).agents[0].status, 'done');
  assert.equal(pool.active, 0);

  assert.equal(delegateCallSchema.safeParse(call(Array.from({ length: 6 }, (_, i) => helper(`H${i}`)))).success, false);
  assert.equal(delegateCallSchema.safeParse(call([helper('Alpha')], 301)).success, false);
  assert.equal(subagentLimits.children, 5);
  assert.equal(subagentLimits.depth, 3);
});

test('a sub-agent past its time limit ends as timed out with its partial output', async () => {
  const timers = manualTimers();
  const { value } = input({
    call: call([helper('Slow'), helper('Fast')], 45),
    setTimer: timers.setTimer,
    run: (spec, live) =>
      spec.name === 'Slow'
        ? untilAborted('Found two vendors so far.', 'Reading a web page')(spec, live)
        : 'Fast report',
  });
  const pending = runSubagents(value);
  await new Promise(resolve => setImmediate(resolve));
  timers.fire();
  const result = await pending;
  const [slow, fast] = result.agents;
  assert.equal(slow.status, 'timed-out');
  assert.match(slow.report, /^Timed out after 45 seconds\. Partial output follows\.\nFound two vendors so far\.$/);
  assert.equal(fast.status, 'done');
  assert.equal(timers.size, 0);
});

test('a timed-out sub-agent without text reports its completed steps', async () => {
  const timers = manualTimers();
  const { value } = input({ setTimer: timers.setTimer, run: untilAborted('', 'Searching the web') });
  const pending = runSubagents(value);
  await new Promise(resolve => setImmediate(resolve));
  timers.fire();
  assert.match((await pending).agents[0].report, /Completed steps: Searching the web\./);
});

test('stopping the reply stops every sub-agent, and Stop on one card stops only that one', async () => {
  const reply = new AbortController();
  let stopCard;
  let unsubscribed = false;
  const { value } = input({
    call: call([helper('Alpha'), helper('Beta'), helper('Gamma')]),
    signal: reply.signal,
    stops: stop => {
      stopCard = stop;
      return () => (unsubscribed = true);
    },
    run: (spec, live) => untilAborted(`${spec.name} partial`)(spec, live),
  });
  const pending = runSubagents(value);
  await new Promise(resolve => setImmediate(resolve));
  stopCard('a1');
  await new Promise(resolve => setImmediate(resolve));
  reply.abort(new Error('reply cancelled'));
  const result = await pending;
  assert.deepEqual(
    result.agents.map(agent => agent.status),
    ['stopped', 'stopped', 'stopped'],
  );
  assert.match(result.agents[1].report, /^Stopped before it finished\. Partial output follows\.\nBeta partial$/);
  assert.equal(unsubscribed, true);
  assert.equal(value.pool.active, 0);
});

test('a per-card Stop leaves the other sub-agents running to completion', async () => {
  let stopCard;
  const { value } = input({
    call: call([helper('Alpha'), helper('Beta')]),
    stops: stop => {
      stopCard = stop;
      return () => {};
    },
    run: async (spec, live) => {
      if (spec.name === 'Alpha') return untilAborted('Alpha partial')(spec, live);
      await new Promise(resolve => setTimeout(resolve, 5));
      return 'Beta report';
    },
  });
  const pending = runSubagents(value);
  await new Promise(resolve => setImmediate(resolve));
  stopCard('a0');
  const result = await pending;
  assert.deepEqual(
    result.agents.map(agent => [agent.status, agent.report]),
    [
      ['stopped', 'Stopped before it finished. Partial output follows.\nAlpha partial'],
      ['done', 'Beta report'],
    ],
  );
});

test('a failed sub-agent shows only a safe error code and its partial output', async () => {
  const { value } = input({
    call: call([helper('Alpha'), helper('Beta')]),
    run: async (spec, live) => {
      live.progress.text('Halfway');
      throw new Error(spec.name === 'Alpha' ? 'task-failed' : 'secret https://internal 42');
    },
  });
  const result = await runSubagents(value);
  assert.equal(result.agents[0].status, 'failed');
  assert.equal(result.agents[0].report, 'The sub-agent failed (task-failed). Partial output: Halfway');
  assert.equal(result.agents[1].report, 'The sub-agent failed. Partial output: Halfway');
});

test('the delegation result fits the reply tool-result cap', async () => {
  const long = 'x'.repeat(20_000);
  const { value } = input({
    call: call([helper('Alpha'), helper('Beta'), helper('Gamma')]),
    resultBytes: 6_000,
    run: async spec => (spec.name === 'Gamma' ? 'short "quoted"\n' : long),
  });
  const result = await runSubagents(value);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 6_000);
  assert.equal(result.agents[2].report, 'short "quoted"');
  assert.match(result.agents[0].report, /\[Report truncated to fit the chat\.\]$/);
  const small = { agents: [{ ...result.agents[2] }], totalCredits: 0 };
  assert.equal(boundSubagentResult(small, 100_000), small);
});

test('helper tools are the intersection of the request, the read-only helper tools, and the chat offer', () => {
  const offered = new Set(['web.search', 'web.fetch', 'rows.list', 'rows.update']);
  assert.deepEqual(helperToolGrant(['web.search', 'rows.update', 'web.search', 'tables.list', 'rows.list'], offered), [
    'web.search',
    'rows.list',
  ]);
  assert.deepEqual(
    helperToolGrant(['agents.delegate', 'plans.start'], new Set(['agents.delegate', 'plans.start'])),
    [],
  );
});

test('helper cards name the chat model family, and saved agent cards name the agent', async () => {
  const agentId = '22222222-2222-4222-8222-222222222222';
  const saved = { kind: 'saved', agentId, role: 'Analyst', task: 'Review the plan' };
  const { value, published } = input({ call: call([helper('Alpha'), saved]), family: 'claude-sonnet' });
  const result = await runSubagents(value);
  for (const cards of [published[0], result.agents])
    assert.deepEqual(
      cards.map(card => [card.family, card.agentId]),
      [
        ['claude-sonnet', undefined],
        [undefined, agentId],
      ],
    );
  const unnamed = await runSubagents(input().value);
  assert.ok(!('family' in unnamed.agents[0]));
});

test('a saved agent child never gets more credits than the chat has left', () => {
  assert.equal(childCreditBudget(undefined, null), subagentLimits.savedAgentCredits);
  assert.equal(childCreditBudget(40, null), 40);
  assert.equal(childCreditBudget(40, 12.7), 12);
  assert.equal(childCreditBudget(undefined, 0), 0);
});

test('delegated task request IDs are stable, UUID-shaped, and bounded by the child limit', () => {
  const callId = '11111111-1111-4111-8111-111111111111';
  assert.equal(delegatedRequestId(callId, 0), delegatedRequestId(callId, 0));
  assert.notEqual(delegatedRequestId(callId, 0), delegatedRequestId(callId, 1));
  assert.match(delegatedRequestId(callId, 4), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => delegatedRequestId(callId, 5), RangeError);
});

test('only chats are offered agents.delegate, and it is refused without a reply context', async () => {
  assert.ok(discoverToolNames({ kind: 'chat' }).includes('agents.delegate'));
  assert.ok(
    !discoverToolNames({ kind: 'agent', tools: ['agents.delegate', 'web.search'] }).includes('agents.delegate'),
  );
  const context = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    actor: { userId: '22222222-2222-4222-8222-222222222222' },
  };
  await assert.rejects(
    createChatTools({}, { telemetryRuntime: 'chat' }).invokeWithSources(context, call([helper('Alpha')])),
    AccessDenied,
  );
  await assert.rejects(createChatTools({}).invoke(context, call([helper('Alpha')])), AccessDenied);
});
