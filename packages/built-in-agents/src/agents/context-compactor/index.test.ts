import { textContent } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { createContextCompactor } from ".";

describe("createContextCompactor", () => {
  it("uses the Turn profile so compaction cannot establish a different Run budget", async () => {
    const invoke = vi.fn().mockResolvedValue({
      requestId: "compact-1",
      output: { kind: "text", text: "Earlier work failed before completion." },
      usage: { inputTokens: 20, outputTokens: 6 },
      budgetSettled: true,
    });
    const compactor = createContextCompactor({ invoke });

    await expect(
      compactor.compact(
        {
          requestId: "compact-1",
          modelProfileId: "primary",
          messages: [
            {
              role: "user",
              content: textContent("The launch code is ORCHID-71. Keep this for later."),
            },
          ],
          maxOutputTokens: 700,
        },
        new AbortController().signal
      )
    ).resolves.toBe("Earlier work failed before completion.");

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "compact-1",
        modelProfileId: "primary",
        maxOutputTokens: 700,
      })
    );
    const prompt = JSON.stringify(invoke.mock.calls[0]?.[0].messages);
    expect(prompt).toContain("ORCHID-71");
    expect(prompt).not.toContain("current request");
  });
});
