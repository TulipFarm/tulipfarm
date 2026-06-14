import { describe, expect, it } from "vitest";
import type { PaginatedResult } from "../pagination";
import type { MessageDoc, MessageRepo } from "./messages";
import { persistStep } from "./routes";

class CapturingRepo implements MessageRepo {
  created: MessageDoc[] = [];
  async create(doc: MessageDoc): Promise<void> {
    this.created.push(doc);
  }
  async listByConversation(): Promise<PaginatedResult<MessageDoc>> {
    return { items: [], nextCursor: null };
  }
}

const textStep = (text: string) => ({ text, finishReason: "stop", toolCalls: [], toolResults: [] });
const noop = () => {};

describe("persistStep reply id", () => {
  it("persists the final text message under the holder's reply id, claimed once", async () => {
    const repo = new CapturingRepo();
    const holder = { id: "REPLY-ID" as string | undefined };

    await persistStep(repo, "convo", textStep("hello"), noop, holder);
    expect(repo.created).toHaveLength(1);
    expect(repo.created[0]._id).toBe("REPLY-ID");
    expect(holder.id).toBeUndefined();

    // A second final-text step in the same turn falls back to a fresh id (no PK collision).
    await persistStep(repo, "convo", textStep("more"), noop, holder);
    expect(repo.created).toHaveLength(2);
    expect(repo.created[1]._id).not.toBe("REPLY-ID");
  });

  it("leaves tool-call step messages untouched and keeps the reply id for the final text", async () => {
    const repo = new CapturingRepo();
    const holder = { id: "REPLY-ID" as string | undefined };
    const toolStep = {
      text: "",
      finishReason: "tool-calls",
      toolCalls: [{ toolCallId: "c1", toolName: "x", input: {} }],
      toolResults: [{ toolCallId: "c1", toolName: "x", output: {} }],
    };

    await persistStep(repo, "convo", toolStep, noop, holder);
    expect(repo.created.every((d) => d._id !== "REPLY-ID")).toBe(true);
    expect(holder.id).toBe("REPLY-ID");

    await persistStep(repo, "convo", textStep("done"), noop, holder);
    expect(repo.created.at(-1)?._id).toBe("REPLY-ID");
  });

  it("stamps model + agent provenance onto assistant messages but not tool messages", async () => {
    const repo = new CapturingRepo();
    const provenance = { model: "model-x", agentId: "InformationArchitect" };

    await persistStep(repo, "convo", textStep("hi"), noop, undefined, provenance);
    expect(repo.created[0].metadata).toEqual({ provenance });

    const toolStep = {
      text: "",
      finishReason: "tool-calls",
      toolCalls: [{ toolCallId: "c1", toolName: "x", input: {} }],
      toolResults: [{ toolCallId: "c1", toolName: "x", output: {} }],
    };
    await persistStep(repo, "convo", toolStep, noop, undefined, provenance);
    const assistantTurn = repo.created.find(
      (d) => d.role === "assistant" && Array.isArray(d.content)
    );
    const toolTurn = repo.created.find((d) => d.role === "tool");
    expect(assistantTurn?.metadata).toEqual({ provenance });
    expect(toolTurn?.metadata).toBeUndefined();
  });
});
