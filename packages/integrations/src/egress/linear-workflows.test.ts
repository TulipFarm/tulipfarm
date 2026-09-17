import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ajv, parseOimManifest } from "@tulipfarm/schema";
import type { ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { beforeAll, describe, expect, it } from "vitest";
import { runOimFixtures } from "./oim-fixtures";
import { OimGraphqlToolAdapter } from "./oim-graphql-adapter";
import { compileOimGraphqlOperations } from "./oim-graphql-compile";

const directory = resolve(import.meta.dirname, "../../../../integrations/linear");

describe("Linear issue workflows", () => {
  let manifest: ReturnType<typeof parseOimManifest>;
  const companions = new Map<string, string>();

  beforeAll(async () => {
    manifest = parseOimManifest(await readFile(resolve(directory, "oim.yml"), "utf8"));
    for (const file of manifest.files ?? []) {
      companions.set(file.path, await readFile(resolve(directory, file.path), "utf8"));
    }
  });

  it("exposes bounded cursors for every metadata connection, not just the first 50 teams", () => {
    for (const id of ["list-teams", "list-team-states", "list-team-members"]) {
      const operation = manifest.operations.find((candidate) => candidate.id === id);
      expect(operation?.requestSchema).toMatchObject({
        properties: {
          first: { type: "integer", minimum: 1, maximum: 50 },
          after: { type: "string", maxLength: 4096 },
        },
        required: expect.arrayContaining(["first"]),
        additionalProperties: false,
      });
    }
  });

  it("pins newest activity ordering and all issue management fields", () => {
    expect(companions.get("operations/list-issues.graphql")).toContain("orderBy: updatedAt");
    const update = manifest.operations.find(({ id }) => id === "update-issue");
    expect(update?.requestSchema).toMatchObject({
      properties: {
        stateId: { type: "string" },
        assigneeId: { type: ["string", "null"] },
        priority: { type: "integer", minimum: 0, maximum: 4 },
        estimate: { type: ["number", "null"], minimum: 0 },
      },
    });
    for (const field of ["priority", "estimate", "assignee", "state"]) {
      expect(companions.get("operations/read-issue.graphql")).toContain(field);
    }
  });

  it("reaches the 51st team through the shipped document and forwards its final cursor", async () => {
    const compiled = compileOimGraphqlOperations(manifest, companions).find(
      ({ operation }) => operation.id === "list-teams"
    );
    if (compiled === undefined) throw new Error("missing list-teams");
    const sent: unknown[] = [];
    const adapter = new OimGraphqlToolAdapter({
      manifest,
      binding: compiled.binding,
      http: {
        async send(request) {
          expect(request.headers.Authorization).toBe("fixture-api-key");
          sent.push(request.body);
          const last = sent.length === 2;
          return {
            status: 200,
            headers: {},
            body: {
              data: {
                teams: {
                  nodes: Array.from({ length: last ? 1 : 50 }, (_, index) => ({
                    id: `team-${last ? 51 : index + 1}`,
                    name: `Team ${last ? 51 : index + 1}`,
                    key: `T${last ? 51 : index + 1}`,
                  })),
                  pageInfo: {
                    hasNextPage: !last,
                    endCursor: last ? "team-51" : "team-50",
                  },
                },
              },
            },
          };
        },
      },
    });
    const argumentsForPage = (after?: string): ToolAdapterRequest => ({
      intent: {
        intentId: "intent-1",
        businessId: "business-1",
        runId: "run-1",
        stateId: "state-1",
        toolId: compiled.toolId,
        toolVersion: manifest.metadata.version,
        action: compiled.contract.spec.action,
        targetRefs: [],
        arguments: { first: 50, ...(after === undefined ? {} : { after }) },
        idempotencyKey: "read-teams",
      },
      idempotencyKey: "read-teams",
      attempt: 1,
    });
    const first = await adapter.dispatch(argumentsForPage(), "fixture-api-key");
    expect(first).toMatchObject({
      data: { teams: { pageInfo: { hasNextPage: true, endCursor: "team-50" } } },
    });
    const last = await adapter.dispatch(argumentsForPage("team-50"), "fixture-api-key");
    expect(last).toMatchObject({
      data: {
        teams: {
          nodes: [{ id: "team-51" }],
          pageInfo: { hasNextPage: false, endCursor: "team-51" },
        },
      },
    });
    expect(sent).toEqual([
      { operationName: "ListTeams", query: compiled.binding.document, variables: { first: 50 } },
      {
        operationName: "ListTeams",
        query: compiled.binding.document,
        variables: { first: 50, after: "team-50" },
      },
    ]);
  });

  it("rejects out-of-bound reads, invalid priorities and query injection at the Tool contract", () => {
    const compiled = compileOimGraphqlOperations(manifest, companions);
    for (const id of ["list-teams", "list-team-states", "list-team-members"]) {
      const tool = compiled.find(({ operation }) => operation.id === id);
      if (tool === undefined) throw new Error(`missing ${id}`);
      const validate = ajv.compile(tool.contract.spec.inputSchema);
      const scope = id === "list-teams" ? {} : { teamId: "team-123" };
      expect(validate({ ...scope, first: 50 })).toBe(true);
      for (const first of [0, 51, 1.5]) expect(validate({ ...scope, first })).toBe(false);
      expect(validate({ ...scope, first: 1, query: "mutation { arbitrary }" })).toBe(false);
    }
    const update = compiled.find(({ operation }) => operation.id === "update-issue");
    if (update === undefined) throw new Error("missing update-issue");
    const validate = ajv.compile(update.contract.spec.inputSchema);
    expect(validate({ id: "issue-1", priority: 4, estimate: null, assigneeId: null })).toBe(true);
    expect(validate({ id: "issue-1", priority: 5 })).toBe(false);
    expect(validate({ id: "issue-1", estimate: -1 })).toBe(false);
  });

  it("keeps metadata read-only and writes reconciled behind the mutation boundary", () => {
    const compiled = compileOimGraphqlOperations(manifest, companions);
    for (const id of ["list-team-states", "list-team-members"]) {
      expect(compiled.find(({ operation }) => operation.id === id)?.contract.spec).toMatchObject({
        mutating: false,
        allowedDestinations: ["api.linear.app"],
      });
    }
    expect(
      compiled.find(({ operation }) => operation.id === "update-issue")?.contract.spec
    ).toMatchObject({ mutating: true, idempotency: { strategy: "reconcile" } });
  });

  it("executes provider-shaped pagination, metadata and mutation error fixtures", async () => {
    const results = await runOimFixtures(manifest, companions);
    expect(results.filter(({ passed }) => !passed)).toEqual([]);
    expect(results.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "teams-first-page",
        "teams-last-page",
        "team-workflow-states",
        "team-members",
        "updates-workflow-fields",
        "clears-assignee-and-estimate",
        "rejects-partial-mutation-error",
      ])
    );
  });
});
