import type {
  ChildAuthority,
  ChildLink,
  ChildLinkAncestry,
  ChildLinkStore,
} from "@tulipfarm/run-kernel";
import {
  AgentLoop,
  type AgentLoopEvent,
  type AgentLoopInput,
  type ChildRunStarter,
  InMemoryLoopCheckpointStore,
  type ModelInvocationResult,
  type ToolDispatchResult,
} from "../../src";

export const TOOL_NAME = "github.issue.comment";

/** Scripted model + broker so each adversarial case states only what it is attacking. */
export function loopHarness(options: {
  results: readonly ModelInvocationResult[];
  dispatches?: readonly ToolDispatchResult[];
  checkpoints?: InMemoryLoopCheckpointStore;
}) {
  const results = [...options.results];
  const dispatches = [...(options.dispatches ?? [])];
  const calls: { name: string; arguments: unknown }[] = [];
  const events: AgentLoopEvent[] = [];

  const loop = new AgentLoop({
    model: {
      invoke: async () => {
        const next = results.shift();
        if (next === undefined) throw new Error("model called more times than scripted");
        return next;
      },
    },
    tools: {
      dispatch: async (call) => {
        calls.push({ name: call.name, arguments: call.arguments });
        return dispatches.shift() ?? { status: "succeeded", callId: call.callId, output: {} };
      },
    },
    checkpoints: options.checkpoints ?? new InMemoryLoopCheckpointStore(),
    events: {
      append: async (event) => {
        events.push(event);
      },
    },
    budget: { consume: async () => ({ outcome: "allowed" }) },
    isCancelled: async () => false,
  });

  const input = (overrides: Partial<AgentLoopInput> = {}): AgentLoopInput => ({
    businessId: "biz-1",
    runId: "run-1",
    stateId: "state-1",
    modelProfileId: "primary",
    contextDigest: "sha256:context",
    guardrailDigest: "sha256:guardrail",
    messages: [{ role: "user", content: "handle the ticket" }],
    tools: [{ name: TOOL_NAME, inputSchema: { type: "object", required: ["body"] } }],
    limits: { maxIterations: 5, maxToolCalls: 5, maxRepairAttempts: 2 },
    ...overrides,
  });

  return { loop, calls, events, input, tools: { calls } };
}

export class FakeChildLinkStore implements ChildLinkStore {
  links: ChildLink[] = [];

  async link(input: {
    parentRunId: string;
    childRunId: string;
    authority: ChildAuthority;
    createdAt: string;
  }): Promise<ChildLink> {
    const link: ChildLink = {
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      authority: input.authority,
      detachedAt: null,
      createdAt: input.createdAt,
    };
    this.links.push(link);
    return link;
  }

  async detach(
    _businessId: string,
    parentRunId: string,
    childRunId: string,
    detachedAt: string
  ): Promise<boolean> {
    const index = this.links.findIndex(
      (link) => link.parentRunId === parentRunId && link.childRunId === childRunId
    );
    const existing = this.links[index];
    if (existing === undefined || existing.detachedAt !== null) return false;
    this.links[index] = { ...existing, detachedAt };
    return true;
  }

  async listChildren(_businessId: string, parentRunId: string): Promise<readonly ChildLink[]> {
    return this.links.filter((link) => link.parentRunId === parentRunId);
  }
}

/** Ancestry over the same fake rows, so depth is read from links a spawn actually wrote. */
export function fakeAncestry(store: FakeChildLinkStore): ChildLinkAncestry {
  return {
    parentLink: async (_businessId, childRunId) =>
      store.links.find((link) => link.childRunId === childRunId) ?? null,
  };
}

/** Records what a delegation would have started; the coordinator owns the only such port. */
export function fakeChildRunStarter(): ChildRunStarter & {
  readonly started: { childRunId: string; authority: ChildAuthority }[];
} {
  const started: { childRunId: string; authority: ChildAuthority }[] = [];
  return {
    started,
    start: async (input) => {
      const childRunId = `run-child-${started.length + 1}`;
      started.push({ childRunId, authority: input.authority });
      return { childRunId, conversationId: `chat-${started.length}` };
    },
    cancel: async () => {},
  };
}
