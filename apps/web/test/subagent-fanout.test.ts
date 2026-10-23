import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delegationView, fanoutRoot, formatCredits } from '../src/features/chat/subagent-fanout-state.ts';
import { createConversationStream } from '../src/features/chat/conversation-stream.ts';

const callId = '33333333-3333-4333-8333-333333333333';
const turnId = '11111111-1111-4111-8111-111111111111';
const card = (key: string, status: string, extra: object = {}) => ({
  key,
  kind: 'helper',
  name: `Agent ${key}`,
  role: 'Researcher',
  status,
  credits: 0.5,
  elapsedMs: 1000,
  ...extra,
});
const live = (agents: object[], seq = 0, receivedAt = 10_000) =>
  ({ turnId, generation: 0, epoch: 0, id: callId, seq, agents, receivedAt }) as never;

test('live cards map onto AgentFanout under the chat, with timed out shown as stopped', () => {
  const view = delegationView(
    { id: callId, tool: 'agents.delegate', status: 'running' },
    live([
      card('a0', 'running', { step: 'Searching the web' }),
      card('a1', 'timed-out'),
      card('a2', 'failed'),
      card('a3', 'queued'),
    ]),
  )!;
  assert.equal(view.totalCredits, 2);
  const root = fanoutRoot(view, 12_500);
  assert.equal(root.status, 'running');
  assert.equal(root.task, 'Running 4 sub-agents');
  assert.deepEqual(
    root.agents!.map(agent => [agent.id, agent.status, agent.task, agent.elapsed, agent.reason]),
    [
      ['a0', 'running', 'Researcher: Searching the web', 3500, undefined],
      ['a1', 'stopped', 'Researcher', 1000, 'Timed out'],
      ['a2', 'failed', 'Researcher', 1000, 'Failed'],
      ['a3', 'queued', 'Researcher', 1000, undefined],
    ],
  );
});

test('the saved result replaces live cards, and other tools have no fan-out', () => {
  const saved = {
    agents: [{ ...card('a0', 'done'), report: 'Findings' }],
    totalCredits: 0.5,
  } as never;
  const view = delegationView(
    { id: callId, tool: 'agents.delegate', status: 'completed', subagents: saved },
    live([]),
  )!;
  assert.equal(view.live, false);
  assert.equal(view.entries[0]!.report, 'Findings');
  assert.equal(fanoutRoot(view, 99_999).agents![0]!.elapsed, 1000);
  assert.equal(fanoutRoot(view, 0).task, 'Ran 1 sub-agent');
  assert.equal(delegationView({ id: callId, tool: 'agents.delegate', status: 'completed' }, live([])), null);
  assert.equal(delegationView({ id: callId, tool: 'web.search', status: 'running' }), null);
  assert.equal(formatCredits(1), '1 credit');
  assert.equal(formatCredits(1.256), '1.26 credits');
});

test('the stream keeps the newest cards of each delegation and clears them on resync', () => {
  const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  const source = {
    readyState: 1,
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close() {},
  };
  const emit = (type: string, data: unknown = '') =>
    listeners.get(type)?.forEach(listener => listener({ data: JSON.stringify(data) } as MessageEvent<string>));
  const stream = createConversationStream('https://api.test/chat/events', () => {}, {
    connect: () => source,
    setTimeout: () => undefined as never,
    clearTimeout: () => {},
  });
  stream.start();
  emit('open');
  const update = (seq: number, status: string) => ({
    turnId,
    generation: 0,
    epoch: 0,
    id: callId,
    seq,
    agents: [card('a0', status)],
  });
  emit('subagents', update(1, 'running'));
  emit('subagents', update(0, 'queued'));
  emit('subagents', { ...update(2, 'done'), agents: [] });
  assert.equal(stream.snapshot().subagents?.get(callId)?.agents[0]!.status, 'running');
  assert.equal(typeof stream.snapshot().subagents?.get(callId)?.receivedAt, 'number');
  emit('resync');
  assert.equal(stream.snapshot().subagents?.size, 0);
});
