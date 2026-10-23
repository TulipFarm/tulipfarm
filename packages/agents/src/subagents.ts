import { recordSubagent } from '@tulipfarm/observability';
import type { SubagentCard, SubagentResult, SubagentStatus } from '@tulipfarm/conversations/events';
import {
  helperToolNames,
  subagentLimits,
  type DelegateCall,
  type HelperToolName,
  type SubagentSpec,
} from './subagent-contracts.ts';

/** What a running sub-agent reports while it works. None of it reaches telemetry. */
export type SubagentProgress = {
  /** The user-visible activity it started, such as "Searching the web". */
  step(activity: string): void;
  /** Its latest interim text, kept as partial output if it ends early. */
  text(partial: string): void;
  /** Credits it spent since the last report. */
  credits(amount: number): void;
  /** The saved agent's own name, once known. */
  named(name: string): void;
};
/** Runs one sub-agent until it reports. It must stop promptly once `signal` aborts. */
export type SubagentRunner = (
  spec: SubagentSpec,
  context: { key: string; signal: AbortSignal; progress: SubagentProgress },
) => Promise<string>;

/** Counts the sub-agents one reply runs at once. */
export function createSubagentPool(limit: number = subagentLimits.children) {
  let active = 0;
  return {
    get active() {
      return active;
    },
    acquire(count: number) {
      if (active + count > limit) return false;
      active += count;
      return true;
    },
    release(count: number) {
      active = Math.max(0, active - count);
    },
  };
}
export type SubagentPool = ReturnType<typeof createSubagentPool>;

/** A helper's tools: what it asked for, limited to read-only helper tools the delegating chat is offered. */
export function helperToolGrant(requested: readonly string[], offered: ReadonlySet<string>): HelperToolName[] {
  return [...new Set(requested)].filter(
    (tool): tool is HelperToolName => (helperToolNames as readonly string[]).includes(tool) && offered.has(tool),
  );
}

/** A saved-agent child's credit budget: what it asked for, never more than the delegating chat has left. */
export function childCreditBudget(requested: number | undefined, remaining: number | null) {
  const wanted = requested ?? subagentLimits.savedAgentCredits;
  return remaining === null ? wanted : Math.max(0, Math.min(wanted, Math.floor(remaining)));
}

export type DelegationRefusal = {
  error: 'delegation-limit' | 'delegation-depth' | 'delegation-tools';
  instruction: string;
};

const ended = new Set<SubagentStatus>(['done', 'failed', 'timed-out', 'stopped']);
const clip = (text: string, length: number) => (text.length <= length ? text : `${text.slice(0, length - 1)}…`);

/** Fits every report into `bytes` of JSON, sharing the room equally and truncating the longest reports first. */
export function boundSubagentResult(result: SubagentResult, bytes: number): SubagentResult {
  const size = (value: SubagentResult) => Buffer.byteLength(JSON.stringify(value));
  if (size(result) <= bytes) return result;
  const marker = '\n[Report truncated to fit the chat.]';
  const empty = { ...result, agents: result.agents.map(agent => ({ ...agent, report: '' })) };
  let room = Math.max(0, bytes - size(empty));
  const order = [...result.agents.keys()].sort(
    (left, right) => Buffer.byteLength(result.agents[left]!.report) - Buffer.byteLength(result.agents[right]!.report),
  );
  const reports: string[] = result.agents.map(() => '');
  for (const [position, index] of order.entries()) {
    const share = Math.floor(room / (order.length - position));
    const report = result.agents[index]!.report;
    // JSON escaping can grow text, so measure the encoded string, not the raw one.
    const encoded = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;
    let fitted = report;
    if (encoded(fitted) > share) {
      let low = 0;
      let high = report.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (encoded(report.slice(0, middle) + marker) <= share) low = middle;
        else high = middle - 1;
      }
      fitted = low ? report.slice(0, low) + marker : '';
    }
    reports[index] = fitted;
    room -= encoded(fitted);
  }
  return { ...result, agents: result.agents.map((agent, index) => ({ ...agent, report: reports[index]! })) };
}

export type DelegationInput = {
  call: DelegateCall;
  /** Depth of the agent that delegates. A chat is depth 0. */
  depth: number;
  pool: SubagentPool;
  /** Aborts when the reply stops; every sub-agent then stops. */
  signal: AbortSignal;
  run: SubagentRunner;
  /** Receives every card change. Publication is a preview; failures must not throw. */
  publish: (cards: SubagentCard[]) => void;
  /** Most bytes the JSON result may take, from the reply's tool-result cap. */
  resultBytes: number;
  /** Registers the per-card Stop listener for this call. Returns the unsubscribe function. */
  stops?: ((stop: (key: string) => void) => () => void) | undefined;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => () => void;
};

/**
 * Starts every sub-agent of one `agents.delegate` call in parallel and waits for all of them. Each has its own time
 * limit; one that reaches it, is stopped by the user, or is stopped with the reply ends with its partial output.
 */
export async function runSubagents(input: DelegationInput): Promise<SubagentResult | DelegationRefusal> {
  const { call } = input;
  if (input.depth >= subagentLimits.depth)
    return {
      error: 'delegation-depth',
      instruction: `Sub-agents may be nested ${subagentLimits.depth} levels deep. Do this work yourself.`,
    };
  if (call.agents.length > subagentLimits.children || !input.pool.acquire(call.agents.length))
    return {
      error: 'delegation-limit',
      instruction: `At most ${subagentLimits.children} sub-agents run at once, and ${input.pool.active} are running. Wait for them, or start fewer.`,
    };
  const now = input.now ?? (() => performance.now());
  const setTimer =
    input.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const limitMs = (call.timeLimitSeconds ?? subagentLimits.defaultSeconds) * 1000;
  const started = now();
  type Entry = {
    card: SubagentCard;
    started: number;
    controller: AbortController;
    reason?: 'timed-out' | 'stopped';
    partial: string;
    steps: string[];
    report: string;
  };
  const entries: Entry[] = call.agents.map((spec, index) => ({
    card: {
      key: `a${index}`,
      kind: spec.kind,
      name: clip(spec.kind === 'helper' ? spec.name : spec.role, 60),
      role: clip(spec.role, 80),
      status: 'queued',
      credits: 0,
      elapsedMs: 0,
    },
    started,
    controller: new AbortController(),
    partial: '',
    steps: [],
    report: '',
  }));
  const publish = () => {
    const at = now();
    for (const entry of entries)
      if (!ended.has(entry.card.status)) entry.card.elapsedMs = Math.max(0, Math.round(at - entry.started));
    try {
      input.publish(entries.map(entry => ({ ...entry.card })));
    } catch {
      /* Live cards are a preview. */
    }
  };
  const stop = (entry: Entry, reason: 'timed-out' | 'stopped') => {
    if (ended.has(entry.card.status) || entry.reason) return;
    entry.reason = reason;
    entry.controller.abort(new Error(`subagent-${reason}`));
  };
  const cancelAll = () => {
    for (const entry of entries) stop(entry, 'stopped');
  };
  if (input.signal.aborted) cancelAll();
  else input.signal.addEventListener('abort', cancelAll, { once: true });
  const unsubscribe = input.stops?.(key => {
    const entry = entries.find(candidate => candidate.card.key === key);
    if (entry) stop(entry, 'stopped');
  });
  publish();
  try {
    await Promise.all(
      entries.map(async (entry, index) => {
        const spec = call.agents[index]!;
        const clear = setTimer(() => stop(entry, 'timed-out'), limitMs);
        const aborted = new Promise<never>((_, reject) => {
          const fail = () => reject(entry.controller.signal.reason);
          if (entry.controller.signal.aborted) fail();
          else entry.controller.signal.addEventListener('abort', fail, { once: true });
        });
        aborted.catch(() => {});
        if (!entry.reason) {
          entry.card.status = 'running';
          entry.started = now();
          publish();
        }
        let outcome: Exclude<SubagentStatus, 'queued' | 'running'>;
        try {
          if (entry.reason) throw entry.controller.signal.reason;
          const report = await Promise.race([
            input.run(spec, {
              key: entry.card.key,
              signal: entry.controller.signal,
              progress: {
                step: activity => {
                  if (ended.has(entry.card.status)) return;
                  entry.card.step = clip(activity, 80);
                  entry.steps.push(entry.card.step);
                  publish();
                },
                text: partial => {
                  if (partial.trim()) entry.partial = partial;
                },
                credits: amount => {
                  if (!(amount > 0)) return;
                  entry.card.credits += amount;
                  publish();
                },
                named: name => {
                  if (name.trim()) entry.card.name = clip(name.trim(), 60);
                },
              },
            }),
            aborted,
          ]);
          if (entry.reason) throw entry.controller.signal.reason;
          entry.report = report.trim() || 'The sub-agent finished without a report.';
          outcome = 'done';
        } catch (error) {
          if (entry.reason) {
            outcome = entry.reason;
            const steps = [...new Set(entry.steps)];
            entry.report = [
              outcome === 'timed-out'
                ? `Timed out after ${Math.round(limitMs / 1000)} seconds. Partial output follows.`
                : 'Stopped before it finished. Partial output follows.',
              entry.partial || (steps.length ? `Completed steps: ${steps.join('; ')}.` : 'No output yet.'),
            ].join('\n');
          } else {
            outcome = 'failed';
            entry.report = `The sub-agent failed${error instanceof Error && /^[a-z][a-z0-9-]{0,63}$/.test(error.message) ? ` (${error.message})` : ''}. ${entry.partial ? `Partial output: ${entry.partial}` : 'It returned no output.'}`;
          }
        } finally {
          clear();
        }
        entry.card.elapsedMs = Math.max(0, Math.round(now() - entry.started));
        entry.card.status = outcome;
        delete entry.card.step;
        recordSubagent(spec.kind, outcome, entry.card.elapsedMs / 1000, entry.card.credits);
        publish();
      }),
    );
  } finally {
    input.signal.removeEventListener('abort', cancelAll);
    unsubscribe?.();
    input.pool.release(entries.length);
  }
  const totalCredits = entries.reduce((sum, entry) => sum + entry.card.credits, 0);
  return boundSubagentResult(
    {
      agents: entries.map(entry => {
        const { step: _step, ...card } = entry.card;
        return { ...card, report: entry.report };
      }),
      totalCredits,
    },
    input.resultBytes,
  );
}

export { resultCapBytes } from './reply-context.ts';
