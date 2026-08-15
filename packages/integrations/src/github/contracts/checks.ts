import type { ToolContractDefinition } from "@tulipfarm/schema";
import {
  GITHUB_ADAPTER_REF,
  GITHUB_DESTINATION,
  GITHUB_TOOL_IDS,
  issueInput,
  PR_DATA_CLASSES,
  publish,
  TOOL_VERSION,
} from "./core";

const checkRunRead = publish(
  {
    toolId: GITHUB_TOOL_IDS.checkRunRead,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.checkRunRead,
    inputSchema: issueInput({ checkRunId: { type: "integer", minimum: 1 } }, ["checkRunId"]),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "status", "conclusion", "htmlUrl"],
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        status: { type: "string" },
        conclusion: { type: ["string", "null"] },
        htmlUrl: { type: "string" },
      },
    },
    riskClass: "low",
    mutating: false,
    dataClasses: PR_DATA_CLASSES,
    allowedDestinations: [GITHUB_DESTINATION],
    idempotency: { strategy: "none" },
    timeout: { wallClockMs: 15_000 },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: GITHUB_ADAPTER_REF },
  },
  "aaaaaaaa-000d-4000-8000-00000000000d",
  "github-check-run-read"
);

export const CHECK_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [checkRunRead];
