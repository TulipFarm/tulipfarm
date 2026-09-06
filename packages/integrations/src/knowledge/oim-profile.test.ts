import { oimManifestIssues } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { knowledgeManifestFixture } from "./oim-manifest.fixture";
import {
  compileKnowledgeProfile,
  DEFAULT_KNOWLEDGE_PAGES_PER_RUN,
  describeKnowledgeProfile,
  OimKnowledgeCompileError,
} from "./oim-profile";

describe("compileKnowledgeProfile", () => {
  it("compiles a manifest the schema already accepts", () => {
    expect(oimManifestIssues(knowledgeManifestFixture())).toEqual([]);
    const plan = compileKnowledgeProfile(knowledgeManifestFixture());
    expect(plan.integrationId).toBe("wiki");
    expect(plan.majorVersion).toBe(2);
    expect(plan.list.operation.id).toBe("list-pages");
    expect(plan.content.operation.id).toBe("get-page");
    expect(plan.acl.operation.id).toBe("get-restrictions");
  });

  it("refuses a manifest that declares no Knowledge profile", () => {
    const manifest = { ...knowledgeManifestFixture(), knowledge: undefined };
    expect(() => compileKnowledgeProfile(manifest)).toThrow(OimKnowledgeCompileError);
  });

  it("refuses a role whose operation was removed", () => {
    const manifest = knowledgeManifestFixture();
    const operations = manifest.operations.filter((operation) => operation.id !== "get-page");
    expect(() => compileKnowledgeProfile({ ...manifest, operations })).toThrow(
      "oim_knowledge_compile:operation_missing:content:get-page"
    );
  });

  // The compiler is the last gate before a plan reaches the network, so it repeats the read-only
  // check rather than trusting that whatever built the manifest ran the validator.
  it("refuses a writing operation even though the manifest object was handed to it directly", () => {
    const manifest = knowledgeManifestFixture();
    const operations = manifest.operations.map((operation) =>
      operation.id === "get-page" ? { ...operation, effect: "delete" as const } : operation
    );
    expect(() => compileKnowledgeProfile({ ...manifest, operations })).toThrow(
      "oim_knowledge_compile:operation_not_read_only:content:get-page"
    );
  });

  it("bounds a Run's walk when the manifest sets no bound", () => {
    expect(compileKnowledgeProfile(knowledgeManifestFixture()).list.maxPagesPerRun).toBe(
      DEFAULT_KNOWLEDGE_PAGES_PER_RUN
    );
  });

  it("keeps a bound the manifest sets", () => {
    const manifest = knowledgeManifestFixture();
    const list = { ...manifest.knowledge?.list, maxPagesPerRun: 3 };
    expect(compileKnowledgeProfile(knowledgeManifestFixture({ list })).list.maxPagesPerRun).toBe(3);
  });

  it("marks sensitive content so no ACL snapshot can be cached for it", () => {
    const manifest = knowledgeManifestFixture();
    const operations = manifest.operations.map((operation) =>
      operation.id === "get-page" ? { ...operation, effect: "sensitive_read" as const } : operation
    );
    expect(compileKnowledgeProfile({ ...manifest, operations }).content.sensitive).toBe(true);
    expect(compileKnowledgeProfile(manifest).content.sensitive).toBe(false);
  });

  it("resolves the discovery operation a user picks a scope from", () => {
    const plan = compileKnowledgeProfile(knowledgeManifestFixture());
    expect(plan.sourceKinds[0]?.discover?.operation.id).toBe("list-spaces");
    expect(plan.sourceKinds[0]?.discover?.idPointer).toBe("/key");
  });

  it("leaves a source kind without discovery undiscoverable rather than guessing an operation", () => {
    const plan = compileKnowledgeProfile(
      knowledgeManifestFixture({ sourceKinds: [{ id: "space", label: "Space" }] })
    );
    expect(plan.sourceKinds[0]?.discover).toBeUndefined();
  });

  it("carries the deleted pointer through for a list-flag deletion", () => {
    const plan = compileKnowledgeProfile(knowledgeManifestFixture());
    expect(plan.deletion).toEqual({ kind: "list_flag", pointer: "/archived" });
  });

  it("resolves a sweep operation for an operation deletion", () => {
    const plan = compileKnowledgeProfile(
      knowledgeManifestFixture({
        deletion: {
          kind: "operation",
          operationId: "list-pages",
          scopeParameter: "spaceKey",
          itemsPointer: "/removed",
          itemIdPointer: "/id",
        },
      })
    );
    expect(plan.deletion).toMatchObject({ kind: "operation", itemsPointer: "/removed" });
  });
});

describe("describeKnowledgeProfile", () => {
  it("names every choice the user has to make before a Routine exists", () => {
    const description = describeKnowledgeProfile(knowledgeManifestFixture());
    expect(description.requiredChoices.map((choice) => choice.id)).toEqual([
      "source_kind",
      "scope",
      "connection",
      "schedule",
    ]);
  });

  it("marks scope discoverable only when the provider can list the scopes", () => {
    expect(
      describeKnowledgeProfile(knowledgeManifestFixture()).requiredChoices.find(
        (choice) => choice.id === "scope"
      )?.discoverable
    ).toBe(true);
    expect(
      describeKnowledgeProfile(
        knowledgeManifestFixture({ sourceKinds: [{ id: "space", label: "Space" }] })
      ).requiredChoices.find((choice) => choice.id === "scope")?.discoverable
    ).toBe(false);
  });

  it("reports which principal kinds the provider's ACLs can grant to", () => {
    expect(describeKnowledgeProfile(knowledgeManifestFixture()).grantsTo).toEqual([
      "user",
      "group",
      "public",
    ]);
  });

  it("reports that deletions propagate, so a user is not told to trust an index that never shrinks", () => {
    expect(describeKnowledgeProfile(knowledgeManifestFixture()).propagatesDeletions).toBe(true);
    const manifest = knowledgeManifestFixture();
    const list = { ...manifest.knowledge?.list, cursor: { kind: "none" } };
    expect(
      describeKnowledgeProfile(knowledgeManifestFixture({ list, deletion: { kind: "none" } }))
        .propagatesDeletions
    ).toBe(false);
  });
});
