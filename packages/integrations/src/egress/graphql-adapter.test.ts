import type { AdapterDispatchError, ToolAdapterRequest } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import type { IntegrationHttpResponse } from "../http";
import { GraphqlToolAdapter } from "./graphql-adapter";
import type { GraphqlOperationBinding } from "./graphql-compile";
import type { EgressHttpPort, EgressHttpRequest } from "./openapi-adapter";

class RecordingHttp implements EgressHttpPort {
  readonly sent: EgressHttpRequest[] = [];

  constructor(private readonly response: IntegrationHttpResponse) {}

  async send(request: EgressHttpRequest): Promise<IntegrationHttpResponse> {
    this.sent.push(request);
    return this.response;
  }
}

function binding(overrides: Partial<GraphqlOperationBinding> = {}): GraphqlOperationBinding {
  return {
    url: "https://api.example.com/graphql",
    operation: "ReadIssue",
    document: "query ReadIssue($id: String!) { issue(id: $id) { id } }",
    mutating: false,
    headers: {},
    ...overrides,
  };
}

function request(arguments_: unknown): ToolAdapterRequest {
  return {
    intent: {
      intentId: "i",
      businessId: "b",
      runId: "r",
      stateId: "s",
      toolId: "graphql.linear.read_issue",
      toolVersion: "1.0.0",
      action: "linear.read_issue",
      targetRefs: [],
      arguments: arguments_,
      idempotencyKey: "k",
    },
    idempotencyKey: "k",
    attempt: 1,
  } as ToolAdapterRequest;
}

describe("GraphqlToolAdapter", () => {
  it("sends the manifest-fixed operation and passes arguments only as variables", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: { data: { issue: {} } } });
    const adapter = new GraphqlToolAdapter({ binding: binding(), http });

    await adapter.dispatch(request({ id: "issue-1" }));

    expect(http.sent[0]).toMatchObject({
      url: "https://api.example.com/graphql",
      method: "POST",
      body: {
        operationName: "ReadIssue",
        query: "query ReadIssue($id: String!) { issue(id: $id) { id } }",
        variables: { id: "issue-1" },
      },
    });
  });

  it("adds the leased credential without returning it to the model", async () => {
    const http = new RecordingHttp({ status: 200, headers: {}, body: { data: {} } });
    const adapter = new GraphqlToolAdapter({
      binding: binding({
        auth: { in: "header", header: "Authorization", format: "Bearer {token}" },
      }),
      http,
    });

    await adapter.dispatch(request({ id: "issue-1" }), "secret-token");

    expect(http.sent[0]?.headers.Authorization).toBe("Bearer secret-token");
  });

  it("treats GraphQL errors in a 200 response as a provider rejection", async () => {
    const adapter = new GraphqlToolAdapter({
      binding: binding(),
      http: new RecordingHttp({
        status: 200,
        headers: {},
        body: { errors: [{ message: "nope" }] },
      }),
    });

    await expect(adapter.dispatch(request({ id: "issue-1" }))).rejects.toMatchObject({
      code: "provider_rejected",
      phase: "before_dispatch",
    } satisfies Partial<AdapterDispatchError>);
  });
});
