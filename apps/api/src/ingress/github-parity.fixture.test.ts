import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HookExecutor } from "@tulipfarm/sandbox";
import { analyzeHook } from "@tulipfarm/sandbox";
import { beforeAll, describe, expect, it } from "vitest";
import { createHookExecutor } from "../hooks/executor";
import { type IngressDecision, parseDecision } from "./classification";

/*
 * Parity guard for the github reference integration (events-only ingress): runs a vendored copy
 * of the integrations repo's github/ingress.ts (__fixtures__/github-ingress.hook.txt) through
 * the real isolated-vm sandbox. The fixture is TEST DATA, not shipped code — keep it
 * byte-identical to TulipFarm/integrations github/ingress.ts.
 */

// isolated-vm has no abi141 prebuild (same caveat as hooks/routine-sandbox.test.ts).
const nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10);
const skipNoIsovm = nodeMajor === 25;

const FAKE_DATABASE_URL = "postgresql://localhost:5432/test";

let source: string;
let executor: HookExecutor;

beforeAll(async () => {
  source = await readFile(join(__dirname, "__fixtures__", "github-ingress.hook.txt"), "utf8");
  executor = createHookExecutor(FAKE_DATABASE_URL);
  return async () => {
    await executor.close();
  };
});

async function classify(
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<IngressDecision | null> {
  const raw = await executor.runRoutineHook(
    source,
    "classify",
    { body, headers, hasThreadMapping: false },
    null,
    "ingress:github-parity"
  );
  return parseDecision(raw);
}

describe("github ingress.ts parity (real sandbox)", () => {
  it("passes the sandbox's static analysis", () => {
    expect(() => analyzeHook(source)).not.toThrow();
  });

  it.skipIf(skipNoIsovm)("compounds the header event name with the body action", async () => {
    const body = { action: "opened", issue: { number: 7 }, repository: { full_name: "o/r" } };
    const d = await classify(body, { "x-github-event": "issues" });
    expect(d).toEqual({ kind: "event", eventType: "issues.opened", payload: body });
  });

  it.skipIf(skipNoIsovm)(
    "uses the bare event name when the body has no action (push)",
    async () => {
      const body = { ref: "refs/heads/main", commits: [] };
      const d = await classify(body, { "x-github-event": "push" });
      expect(d).toEqual({ kind: "event", eventType: "push", payload: body });
    }
  );

  it.skipIf(skipNoIsovm)("ignores the webhook-creation ping", async () => {
    const d = await classify({ zen: "Design for failure." }, { "x-github-event": "ping" });
    expect(d).toMatchObject({ kind: "ignore", reason: "ping" });
  });

  it.skipIf(skipNoIsovm)("ignores deliveries without the event header", async () => {
    const d = await classify({ action: "opened" }, {});
    expect(d).toMatchObject({ kind: "ignore" });
  });
});
