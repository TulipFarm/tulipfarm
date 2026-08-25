import { INVOKE_STATE_KEY, RUN_EXECUTOR_PRINCIPAL_REF } from "@tulipfarm/run-kernel";
import { SUBAGENT_ANSWER_SCHEMA_REF } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  SubagentCompletionStore,
  subagentAnswerArtifactId,
  subagentTurnIdentity,
} from "./completion";

const BUSINESS_ID = "biz-1";
const RUN_ID = "run-child";
const REF = { businessId: BUSINESS_ID, runId: RUN_ID, turnId: INVOKE_STATE_KEY, attempt: 1 };

function fakeArtifacts(existing: ReadonlySet<string> = new Set()) {
  const published: Record<string, unknown>[] = [];
  const present = new Set(existing);
  return {
    published,
    artifacts: {
      async read(input: { artifactId: string }) {
        if (!present.has(input.artifactId)) throw new Error("artifact_not_found");
        return { content: {} };
      },
      async publish(input: Record<string, unknown>) {
        published.push(input);
        present.add(input.id as string);
        return { outcome: "created", id: input.id, contentHash: "h", blob: null };
      },
      // biome-ignore lint/suspicious/noExplicitAny: narrow fake standing in for the real service
    } as any,
  };
}

describe("subagentTurnIdentity", () => {
  it("names the Run's own State and Run rather than inventing a Conversation", () => {
    const identity = subagentTurnIdentity(RUN_ID);

    expect(identity.turnId).toBe(INVOKE_STATE_KEY);
    expect(identity.conversationId).toBe(RUN_ID);
    expect(identity.attempt).toBe(1);
  });
});

describe("SubagentCompletionStore", () => {
  it("publishes the answer as an Artifact under the sub-agent answer schema", async () => {
    const { artifacts, published } = fakeArtifacts();
    const store = new SubagentCompletionStore({ artifacts });

    const result = await store.appendAssistantMessage({
      ...REF,
      content: "the incident is closed",
    });

    expect(result.messageId).toBe(subagentAnswerArtifactId(RUN_ID));
    expect(published).toHaveLength(1);
    expect(published[0]?.schemaRef).toBe(SUBAGENT_ANSWER_SCHEMA_REF);
    expect(published[0]?.value).toEqual({ answer: "the incident is closed", steps: [] });
  });

  it("keeps the answer readable only by the Run executor", async () => {
    const { artifacts, published } = fakeArtifacts();
    const store = new SubagentCompletionStore({ artifacts });

    await store.appendAssistantMessage({ ...REF, content: "done" });

    // Naming a person here would widen the answer beyond the Run that asked for it.
    expect(published[0]?.acl).toEqual({ readers: [RUN_EXECUTOR_PRINCIPAL_REF] });
  });

  it("attributes the Artifact to the Run's invoke State", async () => {
    const { artifacts, published } = fakeArtifacts();
    const store = new SubagentCompletionStore({ artifacts });

    await store.appendAssistantMessage({ ...REF, content: "done" });

    expect(published[0]?.producer).toEqual({
      runId: RUN_ID,
      stateKey: INVOKE_STATE_KEY,
      attempt: 1,
    });
  });

  it("reports no completion while no answer Artifact exists", async () => {
    const { artifacts } = fakeArtifacts();
    const store = new SubagentCompletionStore({ artifacts });

    await expect(store.findCompletion(REF)).resolves.toBeUndefined();
  });

  it("reports completion once the answer Artifact exists, so redelivery answers twice", async () => {
    const { artifacts } = fakeArtifacts();
    const store = new SubagentCompletionStore({ artifacts });

    await store.appendAssistantMessage({ ...REF, content: "done" });

    await expect(store.findCompletion(REF)).resolves.toEqual({
      turnId: INVOKE_STATE_KEY,
      attempt: 1,
      status: "succeeded",
      messageId: subagentAnswerArtifactId(RUN_ID),
    });
  });

  it("keys the answer by Run, so two sub-agents never overwrite each other", async () => {
    const { artifacts } = fakeArtifacts();
    const store = new SubagentCompletionStore({ artifacts });

    await store.appendAssistantMessage({ ...REF, content: "done" });

    await expect(store.findCompletion({ ...REF, runId: "run-other" })).resolves.toBeUndefined();
  });
});
