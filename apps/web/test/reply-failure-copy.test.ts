import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fallbackNote,
  fallbackStarts,
  fallbackSummary,
  planSwitchSummary,
  proposalKeptNote,
  replyFailure,
  replyRetrying,
  retryAction,
  retryHelps,
  unknownStop,
} from '../src/features/chat/reply-failure-copy.ts';
import { planUsageStatus, timeAgo } from '../src/features/chat/plan-usage.ts';

const reasons = [
  'incomplete-response',
  'invalid-decision',
  'invalid-response',
  'output-limit',
  'configuration',
  'authentication',
  'permission',
  'rate-limit',
  'quota',
  'overload',
  'unavailable',
  'timeout',
  'transport',
  'refusal',
  'invalid-request',
  'context-overflow',
  'cancelled',
  'request-failed',
  'something-new',
];

test('every model failure gets short, specific copy with no provider details', () => {
  for (const reason of reasons) {
    const copy = replyFailure(`model-${reason}`);
    assert.ok(copy, reason);
    assert.ok(copy.length < 220, `${reason} copy stays short`);
    assert.doesNotMatch(copy, /model-|http|status|deployment|error code/i, reason);
  }
  assert.match(replyFailure('model-configuration')!, /^This model isn't available\./);
  assert.match(
    replyFailure('model-rate-limit')!,
    /^The model provider is limiting requests, so no answer was written\./,
  );
  for (const reason of ['unavailable', 'overload', 'rate-limit', 'transport', 'timeout'])
    assert.match(
      replyFailure(`model-${reason}`)!,
      /no answer was written\. (TulipFarm|It) retried automatically\./,
      reason,
    );
  assert.match(replyFailure('model-quota')!, /Select another model/);
});

test('a reply that stopped for a non-model cause says why in plain words', () => {
  for (const code of [
    'transient-failure',
    'reply-interrupted',
    'database-conflict',
    'attempts-exhausted',
    'access-denied',
    'something-new',
    null,
    undefined,
  ]) {
    const copy = replyFailure(code);
    assert.ok(copy, String(code));
    assert.doesNotMatch(copy, /[a-z]+-[a-z]+|\.(read|list|search|fetch)\b|error code/i, String(code));
  }
  assert.equal(replyFailure('something-new'), unknownStop);
  assert.match(replyFailure('database-conflict')!, /completed work is kept/);
  assert.equal(replyFailure('model-fallback:kimi'), null);
  assert.equal(replyFailure('credits-exhausted'), null);
});

test('a failed reply with completed tool calls offers Continue', () => {
  const completed = [{ status: 'completed' }];
  assert.deepEqual(retryAction({ errorCode: 'transient-failure' }, completed), {
    label: 'Continue',
    verb: 'Continue',
    resumes: true,
  });
  assert.deepEqual(retryAction({ errorCode: 'transient-failure' }, [{ status: 'failed' }]), {
    label: 'Retry reply',
    verb: 'Retry',
    resumes: false,
  });
  assert.deepEqual(retryAction({ errorCode: 'context-limit' }, completed), {
    label: 'Compact and retry',
    verb: 'Retry',
    resumes: false,
  });
  assert.equal(retryAction({ errorCode: 'model-refusal' }, completed), null);
});

test('a reply that ran out of attempts names only the retry it offers', () => {
  const code = 'attempts-exhausted';
  const stopped =
    'The reply kept hitting a temporary problem, so no answer was written. TulipFarm retried automatically.';
  assert.equal(
    replyFailure(code, retryAction({ errorCode: code }, [{ status: 'completed' }])),
    `${stopped} Your completed work is kept. Continue the reply.`,
  );
  assert.equal(replyFailure(code, retryAction({ errorCode: code }, [])), `${stopped} Retry the reply.`);
  assert.equal(replyFailure(code), stopped);
});

test('a reply the provider would reject again offers no retry and says to reword it', () => {
  for (const code of ['model-refusal', 'model-invalid-request']) assert.equal(retryHelps(code), false, code);
  for (const code of ['model-unavailable', 'model-timeout', 'transient-failure', null, undefined])
    assert.equal(retryHelps(code), true, String(code));
  assert.match(replyFailure('model-refusal')!, /Reword your message and send it again\.$/);
  assert.doesNotMatch(replyFailure('model-refusal')!, /another model|retry/i);
});

test('a queued reply after a model failure says it is retrying instead of spinning silently', () => {
  assert.equal(
    replyRetrying('queued', 'model-unavailable'),
    'The model provider returned an error. Retrying automatically…',
  );
  assert.equal(
    replyRetrying('queued', 'model-rate-limit'),
    'The model provider returned an error. Retrying automatically…',
  );
  assert.match(replyRetrying('queued', 'transient-failure')!, /Retrying automatically/);
  assert.equal(replyRetrying('queued', null), null);
  assert.equal(replyRetrying('processing', 'model-unavailable'), null);
  assert.equal(replyRetrying('queued', 'model-fallback:kimi'), null);
});

test('a completed reply answered by the fallback names the model that answered', () => {
  assert.equal(
    fallbackNote('completed', 'model-fallback:kimi'),
    'Answered by kimi because the chat model was unavailable.',
  );
  const name = (id: string) => ({ kimi: 'Kimi', 'grok-fast': 'Grok Fast' })[id] ?? id;
  assert.equal(
    fallbackNote('completed', 'model-fallback:grok-fast', 'kimi', name),
    'Answered by Grok Fast because Kimi was unavailable.',
  );
  assert.equal(
    fallbackNote('completed', 'model-fallback:grok-fast', 'grok-fast', name),
    'Answered by Grok Fast because the chat model was unavailable.',
  );
  assert.equal(fallbackNote('completed', 'model-fallback:'), null);
  assert.equal(fallbackNote('failed', 'model-fallback:kimi'), null);
  assert.equal(fallbackNote('completed', null), null);
});

test('a fallback reply says why the chat model could not answer, naming whose plan ran out', () => {
  const name = (id: string) =>
    ({
      'grok-fast': 'Grok Fast',
      kimi: 'Kimi',
      'copilot-claude-sonnet-5': 'Claude Sonnet 5',
      'chatgpt-sol': 'GPT Sol',
    })[id] ?? id;
  const note = (code: string, chat: string) =>
    fallbackNote('completed', `model-fallback:grok-fast:${code}`, chat, name);
  const copilot = 'copilot-claude-sonnet-5';
  assert.equal(note('quota:own', copilot), 'Your GitHub Copilot premium quota is used up, so Grok Fast answered.');
  assert.equal(note('quota', copilot), "The GitHub Copilot plan's premium quota is used up, so Grok Fast answered.");
  assert.equal(
    note('quota:own', 'claude-plan-opus'),
    "Your Claude plan's usage limit is reached, so Grok Fast answered.",
  );
  assert.equal(note('quota', 'claude-plan-opus'), "The Claude plan's usage limit is reached, so Grok Fast answered.");
  assert.equal(note('quota', 'chatgpt-sol'), "The ChatGPT plan's usage limit is reached, so Grok Fast answered.");
  assert.equal(
    note('rate-limit:own', copilot),
    'GitHub Copilot is limiting requests right now, so Grok Fast answered.',
  );
  assert.equal(note('outage', 'claude-plan-opus'), "Claude isn't responding right now, so Grok Fast answered.");
  assert.equal(note('timeout', 'chatgpt-sol'), 'ChatGPT took too long to respond, so Grok Fast answered.');
  assert.equal(
    note('model-unavailable:own', copilot),
    "Claude Sonnet 5 isn't available on your GitHub Copilot plan, so Grok Fast answered.",
  );
  assert.equal(
    note('model-unavailable', 'chatgpt-sol'),
    "GPT Sol isn't available on the ChatGPT plan, so Grok Fast answered.",
  );
  assert.equal(note('sign-in:own', copilot), 'GitHub Copilot needs to be reconnected, so Grok Fast answered.');
  assert.equal(note('kimi', copilot), 'No GitHub Copilot plan you can use could answer, so Grok Fast did.');

  assert.equal(note('quota', 'kimi'), 'Kimi has no quota left with its provider, so Grok Fast answered.');
  assert.equal(note('rate-limit', 'kimi'), "Kimi's provider is limiting requests right now, so Grok Fast answered.");
  assert.equal(note('outage', 'kimi'), "Kimi isn't responding right now, so Grok Fast answered.");
  assert.equal(note('timeout', 'kimi'), 'Kimi took too long to respond, so Grok Fast answered.');
  assert.equal(note('model-unavailable', 'kimi'), "Kimi isn't available right now, so Grok Fast answered.");
  assert.equal(note('sign-in', 'kimi'), "Kimi's provider rejected TulipFarm's credentials, so Grok Fast answered.");
  assert.equal(
    fallbackNote('completed', 'model-fallback:grok-fast:timeout', undefined, name),
    'The chat model took too long to respond, so Grok Fast answered.',
  );
});

test('an older fallback code without a reason keeps the general note and neutral plan wording', () => {
  assert.equal(
    fallbackNote('completed', 'model-fallback:grok-fast', 'copilot-claude-sonnet-5'),
    'No GitHub Copilot plan you can use could answer, so grok-fast did.',
  );
  assert.equal(
    fallbackNote('completed', 'model-fallback:grok-fast:something-new', 'kimi'),
    'Answered by grok-fast because kimi was unavailable.',
  );
});

test('a failed reply that saved a table proposal says only its text is missing', () => {
  assert.equal(
    proposalKeptNote([{}, { tableProposal: true }]),
    'Reply text missing. The table change proposal from this reply is still valid.',
  );
  assert.equal(proposalKeptNote([{}]), null);
  assert.equal(proposalKeptNote([]), null);
});

test('a run of replies the same fallback wrote shows its chip once, and again after the chat model answers', () => {
  const messages: unknown[] = [];
  const exchange = (id: string, errorCode: string | null, status = 'completed') =>
    messages.push(
      { id: `${id}-ask`, author: 'user', turn: { status, errorCode, stats: { model: 'chatgpt-sol' } } },
      { id, author: 'assistant' },
    );
  exchange('a', 'model-fallback:grok:quota:own');
  exchange('b', 'model-fallback:grok:quota:own');
  exchange('c', null);
  exchange('d', 'model-fallback:grok:quota:own');
  exchange('e', 'model-fallback:grok:outage');
  exchange('f', 'model-fallback:kimi:outage');
  const starts = fallbackStarts(messages as Parameters<typeof fallbackStarts>[0]);
  assert.deepEqual([...starts.keys()], ['a', 'd', 'f']);
  assert.equal(starts.get('a')?.errorCode, 'model-fallback:grok:quota:own');

  // A reply still being written doesn't end the run it continues.
  messages.length = 0;
  exchange('a', 'model-fallback:grok:quota:own');
  exchange('b', null, 'processing');
  exchange('c', 'model-fallback:grok:quota:own');
  assert.deepEqual([...fallbackStarts(messages as Parameters<typeof fallbackStarts>[0]).keys()], ['a']);
});

test('a fallback chip says briefly who answered and why, tinted by what the member can do', () => {
  const name = (id: string) => ({ grok: 'Grok 4.7', 'chatgpt-sol': 'GPT Sol', kimi: 'Kimi' })[id] ?? id;
  const summary = (code: string, chat = 'chatgpt-sol') =>
    fallbackSummary('completed', `model-fallback:grok:${code}`, chat, name);
  assert.deepEqual(
    (({ short, tone, answered, chosen, plan }) => ({ short, tone, answered, chosen, plan }))(summary('quota:own')!),
    {
      short: 'Your ChatGPT plan limit is reached',
      tone: 'warning',
      answered: 'Grok 4.7',
      chosen: 'chatgpt-sol',
      plan: 'chatgpt',
    },
  );
  assert.equal(summary('quota')?.short, 'The ChatGPT plan limit is reached');
  assert.equal(summary('outage')?.tone, 'info');
  assert.equal(summary('timeout', 'kimi')?.short, 'Kimi took too long');
  assert.deepEqual(
    [summary('sign-in:own')?.tone, summary('sign-in:own')?.short],
    ['action', 'ChatGPT needs reconnecting'],
  );
  // Only the owner can reconnect a shared plan.
  assert.deepEqual(
    [summary('sign-in')?.tone, summary('sign-in')?.short],
    ['warning', 'The ChatGPT plan needs reconnecting'],
  );
  assert.equal(summary('model-unavailable:own')?.short, "GPT Sol isn't on your ChatGPT plan");
  assert.equal(fallbackSummary('failed', 'model-fallback:grok:quota'), null);
  assert.equal(fallbackSummary('completed', null), null);
});

test('a plan model says whose plan it runs on and what is left of it', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  const usage = { plan: 'own', status: 'available', limitedAt: null, premiumRequests: null } as const;
  assert.deepEqual(planUsageStatus('chatgpt', usage, now), {
    plan: 'Your ChatGPT plan',
    status: 'Available',
    warning: false,
    manageUrl: 'https://chatgpt.com/settings/usage',
  });
  const limited = { ...usage, plan: 'shared', status: 'limit-reached', limitedAt: '2026-01-02T10:00:00Z' } as const;
  const claude = planUsageStatus('claude', limited, now);
  assert.deepEqual([claude.plan, claude.status, claude.warning], ['The Claude plan', 'Limit reached · 2 h ago', true]);
  const copilot = (remaining: number) =>
    planUsageStatus('copilot', { ...usage, premiumRequests: { remaining, entitlement: 300 } }, now);
  assert.deepEqual([copilot(212).status, copilot(212).warning], ['212 of 300 premium requests left', false]);
  assert.equal(copilot(0).warning, true);
  // A reached limit outranks the last count read.
  assert.equal(
    planUsageStatus('copilot', { ...limited, premiumRequests: { remaining: 4, entitlement: 300 } }, now).status,
    'Limit reached · 2 h ago',
  );
  assert.deepEqual(
    ['2026-01-02T11:59:30Z', '2026-01-02T11:15:00Z', '2025-12-30T12:00:00Z'].map(at => timeAgo(at, now)),
    ['just now', '45 min ago', '3 d ago'],
  );
});

test('a reply another plan account answered says which and why, naming accounts only for the sender', () => {
  const ids = { from: '11111111-1111-4111-8111-111111111111', to: '22222222-2222-4222-8222-222222222222' };
  const turn = (planSwitch: object | null, status = 'completed') =>
    ({ id: ids.from, status, generation: 0, planSwitch }) as Parameters<typeof planSwitchSummary>[0];
  const own = {
    fromConnectionId: ids.from,
    toConnectionId: ids.to,
    fromAccount: 'ada@acme.co',
    toAccount: 'bot@acme.co',
  };
  assert.deepEqual(planSwitchSummary(turn({ ...own, reason: 'usage-limit' })), {
    to: 'bot@acme.co',
    own: true,
    short: 'ada@acme.co hit its usage limit',
    detail: 'ada@acme.co hit its usage limit, so bot@acme.co answered instead.',
  });
  assert.equal(
    planSwitchSummary(turn({ fromConnectionId: ids.from, toConnectionId: ids.to, reason: 'reconnect' }))?.detail,
    'The chosen account needs reconnecting, so another account answered instead.',
  );
  assert.equal(planSwitchSummary(turn(null)), null);
  assert.equal(planSwitchSummary(turn(own, 'processing')), null);

  const messages = ['a', 'b', 'c'].flatMap(id => [
    { id: `${id}-turn`, author: 'human', turn: turn(id === 'c' ? null : own) },
    { id, author: 'assistant' },
  ]);
  assert.deepEqual([...fallbackStarts(messages as Parameters<typeof fallbackStarts>[0]).keys()], ['a']);
});
