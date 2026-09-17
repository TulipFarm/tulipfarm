import { createHash } from "node:crypto";
import { capToolResult, distilledPayload } from "@tulipfarm/agent-runtime";
import { PACK_READ_MAX_RESULT_CHARS, type PackDefinition } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { NetworkToolContext } from "../tools/network/tools";
import { packReadTool } from "./tool";

function pack(body = "Create support tickets"): PackDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Pack",
    name: "support",
    version: 1,
    title: "Support",
    description: "Support presets",
    category: "Support",
    artifacts: [
      {
        kind: "skill",
        name: "support",
        description: "Support skill",
        template: { name: "support", body },
      },
    ],
    plan: {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Plan",
      name: "support",
      version: 1,
      steps: [{ id: "Inspect", tool: "skill_list" }],
    },
  };
}
function context(): NetworkToolContext {
  return {
    userId: "user",
    runId: "run",
    http: { send: vi.fn(async () => ({ status: 200, headers: {}, body: stringify(pack()) })) },
    assertSkillDestination: vi.fn(),
    useCredential: async () => {
      throw new Error("No credential may be used");
    },
  };
}
describe("pack_read", () => {
  it.each(["", " ", "\t\r\n"])("reads a pinned URL with blank YAML %j", async (yaml) => {
    const ctx = context();
    const expectedSha256 = createHash("sha256").update(stringify(pack())).digest("hex");
    expect(
      await packReadTool.handler(
        { url: "https://example.com/support-triage.yaml", yaml, expectedSha256 },
        ctx
      )
    ).toMatchObject({
      success: true,
      data: { pack: pack(), sha256: expectedSha256 },
    });
    expect(ctx.http.send).toHaveBeenCalledTimes(1);
  });
  it.each(["", " ", "\t\r\n"])("reads exact pasted YAML with blank URL %j", async (url) => {
    const ctx = context();
    const yaml = `\uFEFF\n${stringify(pack())}\n\n`;
    const expectedSha256 = createHash("sha256").update(yaml).digest("hex");
    expect(await packReadTool.handler({ url, yaml, expectedSha256 }, ctx)).toMatchObject({
      success: true,
      data: { pack: pack(), sha256: expectedSha256 },
    });
    expect(ctx.http.send).not.toHaveBeenCalled();
  });
  it("still refuses changed pinned source with an unused blank source field", async () => {
    const ctx = context();
    expect(
      await packReadTool.handler(
        { url: "https://example.com/pack", yaml: " ", expectedSha256: "0".repeat(64) },
        ctx
      )
    ).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("source_changed") },
    });
    expect(ctx.http.send).toHaveBeenCalledTimes(1);
  });
  it("pins a read to exact reviewed source bytes and refuses a changed source", async () => {
    const yaml = stringify(pack());
    const expectedSha256 = createHash("sha256").update(yaml).digest("hex");
    expect(await packReadTool.handler({ yaml, expectedSha256 }, context())).toMatchObject({
      success: true,
      data: { sha256: expectedSha256 },
    });
    const result = await packReadTool.handler({ yaml: `${yaml}\n`, expectedSha256 }, context());
    expect(result).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("source_changed") },
    });
  });
  it("pins URL reads to the expected source digest before exposing a Pack", async () => {
    const ctx = context();
    expect(
      await packReadTool.handler(
        { url: "https://example.com/pack", expectedSha256: "0".repeat(64) },
        ctx
      )
    ).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("fresh preview and confirmation") },
    });
    expect(ctx.http.send).toHaveBeenCalledTimes(1);
  });
  it("returns the entire Pack at the model boundary and rejects even one character over", async () => {
    const base = pack("");
    const overhead = JSON.stringify({ pack: base, sha256: "0".repeat(64) }).length;
    const exact = pack("x".repeat(PACK_READ_MAX_RESULT_CHARS - overhead));
    const result = await packReadTool.handler({ yaml: stringify(exact) }, context());
    expect(result).toMatchObject({ success: true, data: { pack: exact } });
    if (!result.success) throw new Error(result.error.message);
    const payload = await distilledPayload(
      {
        toolName: "pack_read",
        arguments: { yaml: stringify(exact) },
        output: result.data,
        ask: "Preview this Pack.",
        policy: {},
      },
      undefined
    );
    expect(payload.output).toEqual(result.data);
    expect(capToolResult(payload, "pack-read")).toEqual(payload);
    expect(
      await packReadTool.handler(
        { yaml: stringify(pack("x".repeat(PACK_READ_MAX_RESULT_CHARS - overhead + 1))) },
        context()
      )
    ).toMatchObject({
      success: false,
      error: { code: "oversize_value" },
    });
  });
  it("is read-only and returns the complete validated Pack", async () => {
    const ctx = context();
    expect(packReadTool.mutating).toBe(false);
    expect(await packReadTool.handler({ yaml: stringify(pack()) }, ctx)).toMatchObject({
      success: true,
      data: { pack: pack(), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(ctx.http.send).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { url: "", yaml: " " },
    { url: " " },
    { yaml: "\n" },
    { url: "https://example.com", yaml: stringify(pack()) },
    { url: "https://example.com", yaml: "# Not a blank source" },
    { url: "https://example.com", yaml: null },
    { url: "https://example.com", yaml: 0 },
    { yaml: "x", confirm: true },
  ])("refuses invalid arguments", async (args) => {
    const ctx = context();
    expect(await packReadTool.handler(args, ctx)).toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
    expect(ctx.http.send).not.toHaveBeenCalled();
  });
  it("refuses oversize model results rather than returning truncated executable content", async () => {
    expect(
      await packReadTool.handler({ yaml: stringify(pack("x".repeat(40_000))) }, context())
    ).toMatchObject({ success: false, error: { code: "oversize_value" } });
  });
  it("spends the same network budget and does not fetch after exhaustion", async () => {
    const ctx = context();
    const result = await packReadTool.handler(
      { url: "https://example.com/pack" },
      { ...ctx, spendBudget: () => ({ allowed: false, spent: 30, limit: 30 }) }
    );
    expect(result).toMatchObject({ success: false });
    expect(ctx.http.send).not.toHaveBeenCalled();
  });
});
