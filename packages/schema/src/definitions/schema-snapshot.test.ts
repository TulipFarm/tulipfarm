import { describe, expect, it } from "vitest";
import { DEFINITION_REGISTRATIONS } from "./index";

/**
 * The wire contract of every authored definition, locked one file per kind.
 *
 * These schemas are not internal implementation: operators' Soul repositories already hold
 * artifacts validated against them, and their canonical hashes are recorded in published digests.
 * A change here is a **compatibility event** — justify it in review rather than re-locking to make
 * the test quiet.
 *
 * Locking per kind rather than as one combined document means a change surfaces as a diff to
 * exactly the kind that changed; a single 8k-line snapshot would bury it.
 *
 * Re-lock deliberately: `pnpm --filter @tulipfarm/schema test -u`.
 */

/** Key order is an artifact of how a schema is *built*, never of what it *accepts*. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return Object.fromEntries(entries.map(([key, item]) => [key, sortDeep(item)]));
}

const registrations = [...DEFINITION_REGISTRATIONS].sort((left, right) =>
  left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
);

describe("definition schema wire contract", () => {
  // Guards the per-kind snapshots themselves: a kind dropped from the registry would otherwise
  // take its `it.each` case with it and "pass" by never running at all.
  it("locks the set of registered kinds", async () => {
    const kinds = registrations.map((entry) => entry.kind);
    await expect(`${JSON.stringify(kinds, null, 2)}\n`).toMatchFileSnapshot(
      "./__schemas__/_kinds.json"
    );
  });

  it.each(
    registrations.map((entry) => [entry.kind, entry] as const)
  )("%s matches its locked schema", async (kind, registration) => {
    const schema = `${JSON.stringify(sortDeep(registration.schema), null, 2)}\n`;
    await expect(schema).toMatchFileSnapshot(`./__schemas__/${kind}.json`);
  });
});
