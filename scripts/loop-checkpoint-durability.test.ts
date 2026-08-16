import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fitness function for L3-4: durable Agent-loop counters across an approval park.
 *
 * The bounded Tool loop resumes its `toolCalls` and `repairs` limits from a `LoopCheckpointStore`.
 * A store constructed per execution loads nothing on resume, so a waiting State reclaimed after
 * approval restarts both counters at zero and the advertised 25-Tool / 2-repair ceilings become
 * per-park, not per-Run. Only the durable store closes that, and only if every production Agent-loop
 * composition is wired to it. This test stands where the type system cannot: it reads the worker's
 * composition as source and fails the build if a site hard-wires an in-memory store instead of
 * accepting the injected one.
 */

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();
const WORKER_SRC = join(ROOT, "apps/worker/src");
const MAIN = join(WORKER_SRC, "main.ts");

/** Every non-test `.ts` file under `directory`, read as `{ path, source }`. */
function productionSources(directory: string): readonly { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      out.push({ path: full, source: readFileSync(full, "utf8") });
  }
  return out;
}

describe("Agent-loop checkpoint durability (L3-4)", () => {
  const sources = productionSources(WORKER_SRC);

  it("finds the Agent-loop composition sites this test is meant to guard", () => {
    // If nobody constructs an AgentLoop here anymore, the invariants below are vacuous — fail loud.
    const composers = sources.filter(({ source }) => /checkpoints:\s*/.test(source));
    expect(composers.length).toBeGreaterThan(0);
  });

  it("never hard-wires an in-memory checkpoint store into a production AgentLoop", () => {
    // The in-memory store is a legitimate default, but only behind injection. A bare
    // `checkpoints: new InMemoryLoopCheckpointStore()` is the exact wiring that reset the limits.
    for (const { path, source } of sources) {
      const bare = /checkpoints:\s*new InMemoryLoopCheckpointStore\(\)/.test(source);
      expect(bare, `${path} passes a bare in-memory checkpoint store to an AgentLoop`).toBe(false);
    }
  });

  it("keeps the in-memory store only as an injected fallback", () => {
    for (const { path, source } of sources) {
      if (!/InMemoryLoopCheckpointStore/.test(source)) continue;
      const guarded =
        /checkpoints:\s*(?:this\.)?options\.checkpoints\s*\?\?\s*new InMemoryLoopCheckpointStore\(\)/.test(
          source
        );
      expect(guarded, `${path} uses InMemoryLoopCheckpointStore outside a ?? fallback`).toBe(true);
    }
  });

  it("wires the durable checkpoint store from the composition root into every loop site", () => {
    const main = readFileSync(MAIN, "utf8");
    // The root builds the one durable store…
    expect(main).toMatch(/new RunLoopCheckpointStore\(/);
    // …and hands it to each Agent-loop composition it owns.
    const injections = [...main.matchAll(/checkpoints:\s*loopCheckpointStore\b/g)];
    expect(
      injections.length,
      "main.ts must inject the durable store into both the chat executor and the routine agent port"
    ).toBeGreaterThanOrEqual(2);
  });
});
