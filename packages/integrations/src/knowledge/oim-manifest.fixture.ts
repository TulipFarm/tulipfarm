/**
 * A complete OIM Knowledge declaration, shared by the profile, mapping and sync tests.
 *
 * One fixture rather than three near-identical copies: the tests assert different halves of the
 * same manifest, so a divergence between copies would show up as a passing test for a shape no
 * real Integration has.
 */

import type { OimManifest, OimOperation } from "@tulipfarm/schema";

interface FixtureParameter {
  readonly name: string;
  readonly in: "path" | "query";
  readonly required?: boolean;
}

function readOperation(
  id: string,
  name: string,
  path: string,
  parameters: readonly FixtureParameter[],
  overrides: Partial<OimOperation> = {}
): OimOperation {
  return {
    id,
    name,
    description: `Read ${name} from the wiki.`,
    effect: "read",
    identityMode: "shared_only",
    source: {
      type: "http",
      method: "GET",
      baseUrl: "https://wiki.example",
      path,
      parameters: parameters.map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        // Spread rather than assign: an explicit `required: undefined` is not JSON, and
        // canonical hashing of the manifest refuses it.
        ...(parameter.required === undefined ? {} : { required: parameter.required }),
        schema: { type: "string" },
      })),
    },
    response: { schema: { type: "object" }, maxBytes: 1_048_576 },
    ...overrides,
  } as OimOperation;
}

export function knowledgeManifestFixture(
  knowledgeOverrides: Record<string, unknown> = {}
): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "wiki",
      name: "Wiki",
      version: "2.1.0",
      description: "Index wiki spaces.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", knowledge: "1.0" },
    operations: [
      readOperation("list-spaces", "list_spaces", "/rest/space", []),
      readOperation(
        "list-pages",
        "list_pages",
        "/rest/content",
        [
          { name: "spaceKey", in: "query" },
          { name: "since", in: "query" },
        ],
        { pagination: { type: "cursor", requestParameter: "cursor", responsePath: "/next" } }
      ),
      readOperation("get-page", "get_page", "/rest/content/{id}", [
        { name: "id", in: "path", required: true },
      ]),
      readOperation("get-restrictions", "get_restrictions", "/rest/content/{id}/restriction", [
        { name: "id", in: "path", required: true },
      ]),
      readOperation("get-user", "get_user", "/rest/user", [{ name: "accountId", in: "query" }]),
      readOperation("get-group", "get_group", "/rest/group", [{ name: "groupId", in: "query" }]),
    ],
    knowledge: {
      sourceKinds: [
        {
          id: "space",
          label: "Space",
          discoverOperationId: "list-spaces",
          discoverItemsPointer: "/results",
          discoverMapping: { id: "/key", label: "/name" },
        },
      ],
      list: {
        operationId: "list-pages",
        scopeParameter: "spaceKey",
        itemsPointer: "/results",
        mapping: {
          itemId: "/id",
          revision: "/version/number",
          title: "/title",
          sourceUrl: "/_links/webui",
          updatedAt: "/version/when",
          deleted: "/archived",
        },
        cursor: { kind: "operation_pagination" },
      },
      content: {
        operationId: "get-page",
        itemParameter: "id",
        mapping: { content: "/body/storage/value", revision: "/version/number", title: "/title" },
      },
      acl: {
        mode: "item",
        operationId: "get-restrictions",
        itemParameter: "id",
        entriesPointer: "/results",
        entry: {
          kindPointer: "/type",
          kindValues: { user: ["known"], group: ["group"], public: ["anonymous"] },
          providerUserId: "/accountId",
          providerGroupId: "/groupId",
        },
      },
      identity: {
        user: {
          operationId: "get-user",
          idParameter: "accountId",
          mapping: {
            providerId: "/accountId",
            email: "/email",
            emailVerified: "/emailVerified",
          },
        },
        group: {
          operationId: "get-group",
          idParameter: "groupId",
          membersPointer: "/members",
          mapping: { providerId: "/id", memberUserId: "/accountId" },
        },
      },
      deletion: { kind: "list_flag" },
      ...knowledgeOverrides,
    },
  } as OimManifest;
}
