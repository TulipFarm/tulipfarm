import { describe, expect, it } from "vitest";
import { DEFINITION_REGISTRATIONS } from "./index";

/** Schema snapshots are wire contracts; any diff is a compatibility event. Re-lock deliberately. */

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
  // Guards against dropped kinds that would otherwise remove their own snapshot case.
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
