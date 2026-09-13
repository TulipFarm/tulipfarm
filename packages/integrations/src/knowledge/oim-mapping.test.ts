import type { OimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { mapListItems, OimKnowledgeMappingError } from "./oim-mapping";
import { compileKnowledgeProfile } from "./oim-profile";

function manifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "wiki",
      name: "Wiki",
      version: "2.1.0",
      description: "Index wiki pages.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", knowledge: "1.0" },
    operations: [
      {
        id: "list-pages",
        name: "list_pages",
        description: "List pages.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://wiki.example",
          path: "/pages",
          parameters: [],
        },
        response: { schema: { type: "object" }, maxBytes: 1_048_576 },
      },
      {
        id: "get-page",
        name: "get_page",
        description: "Read one page.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://wiki.example",
          path: "/pages/{id}",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
        response: { schema: { type: "object" }, maxBytes: 1_048_576 },
      },
      {
        id: "get-acl",
        name: "get_acl",
        description: "Read one page ACL.",
        effect: "sensitive_read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://wiki.example",
          path: "/pages/{id}/acl",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
        response: { schema: { type: "object" }, maxBytes: 1_048_576 },
      },
    ],
    knowledge: {
      sourceKinds: [{ id: "page", label: "Page" }],
      list: {
        operationId: "list-pages",
        itemsPointer: "/items",
        mapping: { itemId: "/id" },
        cursor: { kind: "none" },
      },
      content: {
        operationId: "get-page",
        itemParameter: "id",
        mapping: { content: "/content" },
      },
      acl: {
        mode: "item",
        operationId: "get-acl",
        itemParameter: "id",
        entriesPointer: "/readers",
        entry: { defaultKind: "user", providerUserId: "/id" },
      },
      deletion: { kind: "absent_from_full_list" },
    },
  };
}

describe("OIM Knowledge list mapping", () => {
  it.each([{}, { items: null }, { items: {} }])(
    "fails the page when the declared list pointer is absent or not an array",
    (response) => {
      const plan = compileKnowledgeProfile(manifest());

      expect(() => mapListItems(plan, response)).toThrow(
        new OimKnowledgeMappingError("list_items_invalid")
      );
    }
  );

  it("fails the page when an item has no mapped identity", () => {
    const plan = compileKnowledgeProfile(manifest());

    expect(() => mapListItems(plan, { items: [{}] })).toThrow(
      new OimKnowledgeMappingError("item_field_invalid")
    );
  });
});
