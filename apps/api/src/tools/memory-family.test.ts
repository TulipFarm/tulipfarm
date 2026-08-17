import type { MemoryDocumentRepo } from "@tulipfarm/memory";
import { describe, expect, it } from "vitest";
import { buildToolRegistry } from "./setup";

const inert = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("not called");
    },
  }
) as never;

function names(services: Parameters<typeof buildToolRegistry>[0]): readonly string[] {
  return buildToolRegistry(services)
    .getAll()
    .map((tool) => tool.name);
}

/**
 * The retired assertion engine offered four memory Tools with a different contract. If any of them
 * were still reachable the model could pick one, and the write would land in a store nothing reads.
 */
describe("the memory Tool family", () => {
  it("offers update_memory, and only update_memory", () => {
    const registered = names({ memoryDocuments: inert as unknown as MemoryDocumentRepo });

    expect(registered.filter((name) => name === "update_memory")).toHaveLength(1);
    expect(registered).not.toContain("recall_memory");
    expect(registered).not.toContain("delete_memory");
    expect(registered).not.toContain("remember_correction");
  });

  it("offers no memory Tool at all when no document repository is wired", () => {
    expect(names({})).not.toContain("update_memory");
  });
});
