import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "./case";
import { toolDispatcher } from "./dispatch";

describe("infrastructure ownership Eval fixture", () => {
  it.each(["independent", "tulipfarm"] as const)(
    "uses the real %s gate rather than a scripted result",
    async (hostingAuthority) => {
      const fixture: EvalCase = {
        id: "ownership",
        tier: "l2",
        agent: "triage",
        hostingAuthority,
        platformTools: ["soul_repo_push"],
        input: [{ role: "user", content: textContent("Push the repository.") }],
        expect: [],
      };
      const dispatcher = toolDispatcher(fixture);
      const result = await dispatcher.port.dispatch({
        name: "soul_repo_push",
        callId: "push",
        arguments: {},
      });
      expect(result.status).toBe(hostingAuthority === "tulipfarm" ? "denied" : "failed");
      expect(dispatcher.denials).toHaveLength(hostingAuthority === "tulipfarm" ? 1 : 0);
    }
  );
});
