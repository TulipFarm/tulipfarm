import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { SoulWriter } from "@tulipfarm/soul";
import { SoulWriteError, type SoulWriteErrorCode } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { guardrailForgeTool } from "./guardrail-tool";
import type { PlatformToolContext } from "./tools";

const BLOCK_DELETE = { guard: "tool_blocklist", block: ["record_delete"] };

function makeSoulWriter(content: string | null) {
  return {
    readWithBase: vi.fn().mockResolvedValue({ content, baseCommit: "base1234" }),
    apply: vi.fn().mockResolvedValue({
      commitSha: "abc1234",
      filesChanged: 1,
      paths: ["guardrails.yaml"],
      pushed: false,
      published: true,
    }),
  } as unknown as SoulWriter & {
    readWithBase: ReturnType<typeof vi.fn>;
    apply: ReturnType<typeof vi.fn>;
  };
}

describe("guardrail_forge", () => {
  let soulWriter: ReturnType<typeof makeSoulWriter>;
  let onGuardrailsChanged: (() => Promise<void>) & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    soulWriter = makeSoulWriter(null);
    onGuardrailsChanged = vi.fn(async () => {}) as typeof onGuardrailsChanged;
  });

  function ctx(): PlatformToolContext {
    return { soulWriter, onGuardrailsChanged };
  }

  it("writes the first Guardrail into an absent policy and reloads it", async () => {
    const result = await guardrailForgeTool.handler({ guard: BLOCK_DELETE }, ctx());

    expect(result).toMatchObject({
      success: true,
      data: { guard: "tool_blocklist", stage: "tool-call", enforced: true, published: true },
    });
    const request = soulWriter.apply.mock.calls[0][0] as {
      businessId: string;
      expectedBaseCommit: string;
      changes: Array<{ target: Record<string, unknown>; content: string }>;
    };
    expect(request.businessId).toBe(DEPLOYMENT_BUSINESS_ID);
    expect(request.expectedBaseCommit).toBe("base1234");
    expect(request.changes.map((change) => change.target)).toEqual([{ kind: "GuardrailsPolicy" }]);
    expect(parseYaml(request.changes[0]?.content)).toEqual({ "tool-call": [BLOCK_DELETE] });
    expect(onGuardrailsChanged).toHaveBeenCalledOnce();
  });

  it("appends to the stage without dropping guards already configured", async () => {
    soulWriter = makeSoulWriter(
      [
        "input:",
        "  - guard: prompt_injection",
        "    sensitivity: high",
        "tool-call:",
        "  - guard: tool_blocklist",
        "    block:",
        "      - run_command",
        "",
      ].join("\n")
    );

    const result = await guardrailForgeTool.handler({ guard: BLOCK_DELETE }, ctx());

    expect(result).toMatchObject({ success: true });
    const request = soulWriter.apply.mock.calls[0][0] as {
      changes: Array<{ content: string }>;
    };
    expect(parseYaml(request.changes[0]?.content)).toEqual({
      input: [{ guard: "prompt_injection", sensitivity: "high" }],
      "tool-call": [{ guard: "tool_blocklist", block: ["run_command"] }, BLOCK_DELETE],
    });
  });

  it("derives the stage from the guard name rather than trusting a caller", async () => {
    const result = await guardrailForgeTool.handler(
      { guard: { guard: "content_filter", patterns: ["credit_card"] } },
      ctx()
    );

    expect(result).toMatchObject({ success: true, data: { stage: "output" } });
    const request = soulWriter.apply.mock.calls[0][0] as { changes: Array<{ content: string }> };
    expect(parseYaml(request.changes[0]?.content)).toEqual({
      output: [{ guard: "content_filter", patterns: ["credit_card"] }],
    });
  });

  it("refuses malformed guards, unknown guards and duplicates before writing", async () => {
    const unknown = await guardrailForgeTool.handler({ guard: { guard: "ai_disclosure" } }, ctx());
    expect(unknown).toMatchObject({ success: false, error: { code: "validation_error" } });

    const malformed = await guardrailForgeTool.handler(
      { guard: { guard: "content_filter", patterns: ["passport_number"] } },
      ctx()
    );
    expect(malformed).toMatchObject({ success: false, error: { code: "validation_error" } });

    const missing = await guardrailForgeTool.handler({ guard: {} }, ctx());
    expect(missing).toMatchObject({ success: false, error: { code: "validation_error" } });

    const extra = await guardrailForgeTool.handler(
      { guard: BLOCK_DELETE, stage: "tool-call" },
      ctx()
    );
    expect(extra).toMatchObject({ success: false, error: { code: "validation_error" } });

    soulWriter = makeSoulWriter(
      "tool-call:\n  - guard: tool_blocklist\n    block:\n      - record_delete\n"
    );
    const duplicate = await guardrailForgeTool.handler({ guard: BLOCK_DELETE }, ctx());
    expect(duplicate).toMatchObject({ success: false, error: { code: "validation_error" } });

    expect(soulWriter.apply).not.toHaveBeenCalled();
    expect(onGuardrailsChanged).not.toHaveBeenCalled();
  });

  it("refuses to clobber a guardrails.yaml that is not a mapping", async () => {
    soulWriter = makeSoulWriter("- guard: tool_blocklist\n");
    const result = await guardrailForgeTool.handler({ guard: BLOCK_DELETE }, ctx());

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("refuses to write when the policy cannot be reloaded", async () => {
    const result = await guardrailForgeTool.handler({ guard: BLOCK_DELETE }, { soulWriter });

    expect(result).toMatchObject({ success: false, error: { code: "internal_error" } });
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("maps writer failures without reporting a Guardrail as enforced", async () => {
    soulWriter.apply.mockRejectedValueOnce(
      new SoulWriteError("CONFLICT" satisfies SoulWriteErrorCode, "the tree changed under us")
    );
    const result = await guardrailForgeTool.handler({ guard: BLOCK_DELETE }, ctx());

    expect(result).toMatchObject({ success: false, error: { code: "unavailable" } });
    expect(onGuardrailsChanged).not.toHaveBeenCalled();
  });

  it("still reports an unpublished write as enforced, and says publication failed", async () => {
    soulWriter.apply.mockResolvedValueOnce({
      commitSha: "abc1234",
      filesChanged: 1,
      paths: ["guardrails.yaml"],
      pushed: false,
      published: false,
      publicationError: "bundle storage unavailable",
    });
    const result = await guardrailForgeTool.handler({ guard: BLOCK_DELETE }, ctx());

    expect(result).toMatchObject({
      success: true,
      data: { enforced: true, published: false, publicationError: "bundle storage unavailable" },
    });
    expect(onGuardrailsChanged).toHaveBeenCalledOnce();
  });

  it("is a mutating platform Tool gated on the Soul guardrails policy", () => {
    expect(guardrailForgeTool.mutating).toBe(true);
    expect(guardrailForgeTool.authorization).toMatchObject({
      action: "platform.guardrail.forge",
      resources: ["soul.guardrails"],
    });
  });
});
