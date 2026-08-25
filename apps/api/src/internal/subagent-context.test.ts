import type { ArtifactService } from "@tulipfarm/run-kernel";
import { contentText, type SubagentRequest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { ToolRegistry } from "../broker/tool-adapter";
import { SubagentTurnContextResolver } from "./subagent-context";
import type { RunAuthority } from "./turn-host";

const BUSINESS_ID = "biz-1";
const RUN_ID = "run-child";

const AUTHORITY: RunAuthority = {
  businessId: BUSINESS_ID,
  runId: RUN_ID,
  subject: { kind: "user", id: "user-1" },
  source: "subagent",
  bundleDigest: "bundle-1",
};

const REQUEST: SubagentRequest = {
  persona: { name: "Summarizer", instructions: "Answer in one sentence." },
  task: "Summarize the incident.",
  parentRunId: "run-parent",
};

function fakeArtifacts(content: unknown): ArtifactService {
  return {
    async read() {
      return { content } as Awaited<ReturnType<ArtifactService["read"]>>;
    },
  } as unknown as ArtifactService;
}

function fakeRegistry(names: readonly string[]): ToolRegistry {
  return {
    getAll: () =>
      names.map((name) => ({
        name,
        description: `${name} tool`,
        inputSchema: { type: "object" },
        tier: "read",
        mutating: false,
      })),
  } as unknown as ToolRegistry;
}

function resolverFor(request: unknown, tools: readonly string[] = []) {
  return new SubagentTurnContextResolver({
    artifacts: fakeArtifacts(request),
    toolRegistry: fakeRegistry(tools),
  });
}

describe("SubagentTurnContextResolver", () => {
  it("builds a two-message Context from the persona and the task, with no history", async () => {
    const context = await resolverFor(REQUEST).resolve(AUTHORITY);

    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]?.role).toBe("system");
    expect(context.messages[1]?.role).toBe("user");
    expect(contentText(context.messages[1]?.content)).toBe("Summarize the incident.");
    expect(context.agentId).toBe("Summarizer");
    expect(context.compacted).toBe(false);
    expect(context.attachments).toBeUndefined();
  });

  it("keeps the platform framing ahead of the model-authored persona", async () => {
    const context = await resolverFor(REQUEST).resolve(AUTHORITY);
    const system = contentText(context.messages[0]?.content);

    // Instructions a model wrote must not be able to redefine what a sub-agent structurally is,
    // so the fixed framing is emitted first and the persona is appended to it.
    expect(system.indexOf("You are")).toBeLessThan(system.indexOf("Answer in one sentence."));
    expect(system).toContain("You answer once.");
  });

  it("carries the caller's context object into the task message", async () => {
    const context = await resolverFor({
      ...REQUEST,
      context: { ticketId: "T-9" },
    }).resolve(AUTHORITY);

    expect(contentText(context.messages[1]?.content)).toContain('"ticketId": "T-9"');
  });

  it("offers only the Tools the request named", async () => {
    const context = await resolverFor({ ...REQUEST, toolNames: ["kv_get"] }, [
      "kv_get",
      "kv_set",
      "send_email",
    ]).resolve(AUTHORITY);

    expect(context.tools.map((tool) => tool.name)).toEqual(["kv_get"]);
  });

  it("offers no Tools at all when the request named none", async () => {
    // Failing closed matters more here than for a chat Turn: the request was authored by a model,
    // so a helper spawned without an explicit list must not inherit its parent's whole registry.
    const context = await resolverFor(REQUEST, ["kv_get", "send_email"]).resolve(AUTHORITY);

    expect(context.tools).toEqual([]);
  });

  it("ignores a Tool name the registry does not hold", async () => {
    const context = await resolverFor({ ...REQUEST, toolNames: ["kv_get", "invented_tool"] }, [
      "kv_get",
    ]).resolve(AUTHORITY);

    expect(context.tools.map((tool) => tool.name)).toEqual(["kv_get"]);
  });

  it("refuses a request that names no persona rather than inventing one", async () => {
    await expect(
      resolverFor({ task: "do it", parentRunId: "p" }).resolve(AUTHORITY)
    ).rejects.toThrow("turn_not_found");
  });

  it("refuses a request that names no task", async () => {
    await expect(
      resolverFor({ persona: REQUEST.persona, parentRunId: "p" }).resolve(AUTHORITY)
    ).rejects.toThrow("turn_not_found");
  });

  it("reads the request Artifact belonging to its own Run", async () => {
    let askedFor: string | undefined;
    const artifacts = {
      async read(input: { artifactId: string }) {
        askedFor = input.artifactId;
        return { content: REQUEST };
      },
    } as unknown as ArtifactService;

    await new SubagentTurnContextResolver({ artifacts }).resolve(AUTHORITY);

    expect(askedFor).toContain(RUN_ID);
  });
});
