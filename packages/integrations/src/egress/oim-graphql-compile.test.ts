import type { OimManifest, OimOperation } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { compileOimGraphqlOperations, OimGraphqlCompileError } from "./oim-graphql-compile";

const READ_DOCUMENT = `query ListTeams($first: Int!) {
  teams(first: $first) { nodes { id name } }
}`;

const WRITE_DOCUMENT = `mutation CreateIssue($teamId: String!, $title: String!) {
  issueCreate(input: { teamId: $teamId, title: $title }) { success }
}`;

function operation(overrides: Partial<OimOperation> = {}): OimOperation {
  return {
    id: "list-teams",
    name: "tasks_list_teams",
    description: "List teams.",
    effect: "read",
    identityMode: "shared_only",
    credentialSlot: "api_key",
    credentialInjection: { in: "header", name: "Authorization", format: "{token}" },
    source: {
      type: "graphql",
      url: "https://api.tasks.example/graphql",
      operation: "ListTeams",
      documentFile: "operations/list-teams.graphql",
    },
    requestSchema: {
      type: "object",
      properties: { first: { type: "integer" } },
      required: ["first"],
      additionalProperties: false,
    },
    response: { schema: { type: "object" }, maxBytes: 65_536 },
    ...overrides,
  } as OimOperation;
}

function manifest(...operations: OimOperation[]): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "tasks",
      name: "Tasks",
      version: "1.0.0",
      description: "Read and write tasks.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: operations.length === 0 ? [operation()] : operations,
  } as OimManifest;
}

const documents = new Map([
  ["operations/list-teams.graphql", READ_DOCUMENT],
  ["operations/create-issue.graphql", WRITE_DOCUMENT],
]);

describe("compileOimGraphqlOperations", () => {
  it("binds the manifest's own document, never an Agent argument", () => {
    const [compiled] = compileOimGraphqlOperations(manifest(), documents);

    expect(compiled?.binding).toEqual({
      url: "https://api.tasks.example/graphql",
      operation: "ListTeams",
      document: READ_DOCUMENT,
      mutating: false,
      maxResponseBytes: 65_536,
      headers: {},
      auth: {
        in: "header",
        credentialSlot: "api_key",
        header: "Authorization",
        format: "{token}",
      },
    });
    expect(compiled?.contract.spec.adapter.kind).toBe("graphql");
    expect(compiled?.contract.spec.allowedDestinations).toEqual(["api.tasks.example"]);
    expect(compiled?.contract.spec.retry).toEqual({ maxAttempts: 3, safeToRetry: true });
    expect(compiled?.contract.spec.inputSchema).toEqual(operation().requestSchema);
  });

  it("compiles host-managed cursor pagination into opaque Tool input and output fields", () => {
    const paginated = operation({
      requestSchema: {
        type: "object",
        properties: {
          first: { type: "integer" },
          after: { type: "string" },
        },
        required: ["first"],
        additionalProperties: false,
      },
      pagination: {
        type: "cursor",
        requestParameter: "after",
        responsePath: "/data/teams/pageInfo/endCursor",
        itemsPath: "/data/teams/nodes",
      },
    });
    const paginatedDocuments = new Map(documents);
    paginatedDocuments.set(
      "operations/list-teams.graphql",
      `query ListTeams($first: Int!, $after: String) {
  teams(first: $first, after: $after) { nodes { id name } pageInfo { endCursor } }
}`
    );
    const [compiled] = compileOimGraphqlOperations(manifest(paginated), paginatedDocuments);
    const input = compiled?.contract.spec.inputSchema as Record<string, unknown>;
    const output = compiled?.contract.spec.outputSchema as Record<string, unknown>;

    expect(input.properties).toMatchObject({ first: { type: "integer" }, page_token: {} });
    expect(input.properties).not.toHaveProperty("after");
    expect(output.properties).toHaveProperty("next_page_token");
    expect(compiled?.pagination).toEqual(paginated.pagination);
  });

  it("rejects link pagination because a fixed GraphQL endpoint cannot resume a provider URL", () => {
    expect(() =>
      compileOimGraphqlOperations(manifest(operation({ pagination: { type: "link" } })), documents)
    ).toThrow(new OimGraphqlCompileError("pagination_unsupported", "list-teams"));
  });

  it("rejects body cursor pagination instead of silently discarding it", () => {
    expect(() =>
      compileOimGraphqlOperations(
        manifest(
          operation({
            pagination: {
              type: "body_cursor",
              requestPointer: "/after",
              responsePath: "/data/teams/pageInfo/endCursor",
            },
          })
        ),
        documents
      )
    ).toThrow(new OimGraphqlCompileError("pagination_unsupported", "list-teams"));
  });

  it("rejects pagination when the fixed document does not declare its variable", () => {
    expect(() =>
      compileOimGraphqlOperations(
        manifest(
          operation({
            pagination: {
              type: "cursor",
              requestParameter: "after",
              responsePath: "/data/teams/pageInfo/endCursor",
            },
          })
        ),
        documents
      )
    ).toThrow(new OimGraphqlCompileError("pagination_variable_missing", "list-teams"));
  });

  it("binds adapter identity to the pinned companion document", () => {
    const [first] = compileOimGraphqlOperations(manifest(), documents);
    const changed = new Map(documents);
    changed.set("operations/list-teams.graphql", `${READ_DOCUMENT}\n`);
    const [second] = compileOimGraphqlOperations(manifest(), changed);

    expect(first?.adapterRef).not.toBe(second?.adapterRef);
  });

  it("resolves a templated endpoint from Connection configuration", () => {
    const input = manifest();
    input.auth = {
      credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
      configurationFields: [{ id: "shop", label: "Shop host", type: "string" }],
      allowedOriginHosts: ["*.myshopify.com"],
      steps: [],
    };
    const operation = input.operations[0];
    if (operation === undefined || operation.source.type !== "graphql") throw new Error("fixture");
    operation.source.url = "https://{shop}/admin/api/2026-07/graphql.json";

    const [registered] = compileOimGraphqlOperations(
      input,
      documents,
      {},
      {
        deferConfiguration: true,
      }
    );
    expect(() => compileOimGraphqlOperations(input, documents)).toThrow(
      expect.objectContaining({ code: "origin_unconfigured" })
    );
    const [compiled] = compileOimGraphqlOperations(input, documents, {
      shop: "muskan-store.myshopify.com",
    });

    expect(compiled?.binding.url).toBe(
      "https://muskan-store.myshopify.com/admin/api/2026-07/graphql.json"
    );
    expect(compiled?.contract.spec.allowedDestinations).toEqual(["muskan-store.myshopify.com"]);
    expect(compiled?.adapterRef).toBe(registered?.adapterRef);
  });

  it("compiles only graphql sources, leaving http ones to the http compiler", () => {
    const http = {
      ...operation({ id: "ping", name: "tasks_ping" }),
      source: { type: "http", method: "GET", baseUrl: "https://api.tasks.example", path: "/ping" },
    } as OimOperation;

    expect(compileOimGraphqlOperations(manifest(operation(), http), documents)).toHaveLength(1);
  });

  it("binds the OIM-declared provider retry header", () => {
    const declared = operation({
      rateLimit: {
        requests: 10,
        perSeconds: 60,
        scope: "connection",
        retryAfterHeader: "X-Rate-Reset",
      },
    });

    expect(
      compileOimGraphqlOperations(manifest(declared), documents)[0]?.binding.retryAfterHeader
    ).toBe("X-Rate-Reset");
  });

  it("marks a declared write mutating and raises its risk", () => {
    const write = operation({
      id: "create-issue",
      name: "tasks_create_issue",
      effect: "create",
      source: {
        type: "graphql",
        url: "https://api.tasks.example/graphql",
        operation: "CreateIssue",
        documentFile: "operations/create-issue.graphql",
      },
    });
    const [compiled] = compileOimGraphqlOperations(manifest(write), documents);

    expect(compiled?.mutating).toBe(true);
    expect(compiled?.contract.spec.riskClass).toBe("medium");
    expect(compiled?.contract.spec.idempotency.strategy).toBe("reconcile");
  });

  it("refuses a mutation declared as a read", () => {
    const disguised = operation({
      source: {
        type: "graphql",
        url: "https://api.tasks.example/graphql",
        operation: "CreateIssue",
        documentFile: "operations/create-issue.graphql",
      },
    });

    expect(() => compileOimGraphqlOperations(manifest(disguised), documents)).toThrow(
      new OimGraphqlCompileError("effect_mismatch", "list-teams")
    );
  });

  it("refuses a read declared as a write", () => {
    const misdeclared = operation({ effect: "update" });

    expect(() => compileOimGraphqlOperations(manifest(misdeclared), documents)).toThrow(
      new OimGraphqlCompileError("effect_mismatch", "list-teams")
    );
  });

  it("refuses variables the Agent could extend", () => {
    const open = operation({ requestSchema: { type: "object", properties: {} } });

    expect(() => compileOimGraphqlOperations(manifest(open), documents)).toThrow(
      new OimGraphqlCompileError("variables_schema_invalid", "list-teams")
    );
  });

  it("refuses an operation the document does not define", () => {
    const missing = operation({
      source: {
        type: "graphql",
        url: "https://api.tasks.example/graphql",
        operation: "ListProjects",
        documentFile: "operations/list-teams.graphql",
      },
    });

    expect(() => compileOimGraphqlOperations(manifest(missing), documents)).toThrow(
      new OimGraphqlCompileError("operation_not_found", "list-teams")
    );
  });

  it("refuses a document the package did not ship", () => {
    expect(() => compileOimGraphqlOperations(manifest(), new Map())).toThrow(
      new OimGraphqlCompileError("document_missing", "list-teams")
    );
  });

  it("refuses a credential the endpoint would carry in its query string", () => {
    const inQuery = operation({
      credentialInjection: { in: "query", name: "api_key", format: "{token}" },
    });

    expect(() => compileOimGraphqlOperations(manifest(inQuery), documents)).toThrow(
      new OimGraphqlCompileError("credential_injection_unsupported", "list-teams")
    );
  });

  it("refuses a slot with nowhere to put the credential", () => {
    const unplaced = { ...operation() } as { credentialInjection?: unknown };
    unplaced.credentialInjection = undefined;

    expect(() =>
      compileOimGraphqlOperations(manifest(unplaced as OimOperation), documents)
    ).toThrow(new OimGraphqlCompileError("credential_injection_missing", "list-teams"));
  });

  it("refuses an endpoint on a private address", () => {
    const internal = operation({
      source: {
        type: "graphql",
        url: "https://10.0.0.5/graphql",
        operation: "ListTeams",
        documentFile: "operations/list-teams.graphql",
      },
    });

    expect(() => compileOimGraphqlOperations(manifest(internal), documents)).toThrow(
      new OimGraphqlCompileError("destination_invalid", "list-teams")
    );
  });

  it("refuses a templated endpoint outside the declared host cage", () => {
    const input = manifest();
    input.auth = {
      credentialSlots: [{ id: "api_key", label: "API key", kind: "api_key" }],
      configurationFields: [{ id: "shop", label: "Shop host", type: "string" }],
      allowedOriginHosts: ["*.myshopify.com"],
      steps: [],
    };
    const operation = input.operations[0];
    if (operation === undefined || operation.source.type !== "graphql") throw new Error("fixture");
    operation.source.url = "https://{shop}/admin/api/2026-07/graphql.json";

    expect(() =>
      compileOimGraphqlOperations(input, documents, { shop: "attacker.example" })
    ).toThrow(expect.objectContaining({ code: "origin_not_allowed" }));
  });
});

describe("compileOimGraphqlOperations credential encoding", () => {
  it("carries a basic encoding into the binding", () => {
    const basic = operation({
      credentialInjection: {
        in: "header",
        name: "Authorization",
        format: "Basic {token}",
        encoding: "basic",
      },
    });
    const [compiled] = compileOimGraphqlOperations(manifest(basic), documents);

    expect(compiled?.binding.auth).toEqual({
      in: "header",
      credentialSlot: "api_key",
      header: "Authorization",
      format: "Basic {token}",
      encoding: "basic",
    });
  });
});
