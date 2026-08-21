import { describe, expect, it } from "vitest";
import { compileGraphqlEgress, GraphqlCompileError } from "./graphql-compile";

const variables = {
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string" } },
  required: ["id"],
};

const egress = {
  type: "graphql" as const,
  url: "https://api.example.com/graphql",
  auth: { token_env: "ACME_TOKEN" },
  operations: [
    {
      name: "read_issue",
      description: "Read one issue by id.",
      operation: "ReadIssue",
      document: "query ReadIssue($id: String!) { issue(id: $id) { id title } }",
      variables_schema: variables,
    },
    {
      name: "create_issue",
      description: "Create one issue in the selected team.",
      operation: "CreateIssue",
      document:
        "mutation CreateIssue($id: String!) { issueCreate(input: { teamId: $id }) { success } }",
      variables_schema: variables,
    },
  ],
};

describe("compileGraphqlEgress", () => {
  it("publishes fixed operations and derives mutation risk from the document", () => {
    const tools = compileGraphqlEgress({ slug: "linear", egress });

    expect(tools.map((tool) => tool.name)).toEqual(["read_issue", "create_issue"]);
    expect(tools.map((tool) => tool.mutating)).toEqual([false, true]);
    expect(tools[0]?.contract.spec.allowedDestinations).toEqual(["api.example.com"]);
    expect(tools[0]?.binding.document).toContain("query ReadIssue");
  });

  it("refuses a Tool whose selected operation does not match its static document", () => {
    expect(() =>
      compileGraphqlEgress({
        slug: "linear",
        egress: {
          ...egress,
          operations: [{ ...egress.operations[0], operation: "DifferentOperation" }],
        },
      })
    ).toThrow(GraphqlCompileError);
  });

  it("refuses an open variables object so callers cannot add unreviewed inputs", () => {
    expect(() =>
      compileGraphqlEgress({
        slug: "linear",
        egress: {
          ...egress,
          operations: [
            { ...egress.operations[0], variables_schema: { type: "object", properties: {} } },
          ],
        },
      })
    ).toThrow(/variables_schema_invalid/);
  });

  it("refuses dynamic endpoints", () => {
    expect(() =>
      compileGraphqlEgress({ slug: "linear", egress: { ...egress, url: "https://{host}/graphql" } })
    ).toThrow(/url_invalid/);
  });
});
