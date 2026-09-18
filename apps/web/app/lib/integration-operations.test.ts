import { expect, test, vi } from "vitest";
import { apiGet, apiWrite } from "./api";
import { getIntegrationOperations, saveKnowledgeSubscription } from "./integration-operations";

vi.mock("./api", () => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));

test("uses the protected shared API client and preserves exact encoded Connection identity", async () => {
  const signal = new AbortController().signal;
  await getIntegrationOperations("wiki/v1", signal);
  expect(apiGet).toHaveBeenCalledWith("/api/v1/integrations/wiki%2Fv1/operations", { signal });
  const input = { sourceKindId: "space", scopes: ["selected"], enabled: true };
  await saveKnowledgeSubscription("wiki/v1", "connection/a", input);
  expect(apiWrite).toHaveBeenCalledWith(
    "PUT",
    "/api/v1/integrations/wiki%2Fv1/connections/connection%2Fa/knowledge-subscription",
    input
  );
});
