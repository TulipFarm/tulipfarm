import type { ToolContractDefinition } from "@tulipfarm/schema";
import {
  GITHUB_ADAPTER_REF,
  GITHUB_DESTINATION,
  GITHUB_TOOL_IDS,
  issueInput,
  PR_DATA_CLASSES,
  publish,
  repositoryProperty,
  TOOL_VERSION,
} from "./core";

const contentPathProperty = { type: "string", minLength: 1, maxLength: 1024 } as const;
const contentRefProperty = { type: "string", minLength: 1, maxLength: 250 } as const;

const contentRead = publish(
  {
    toolId: GITHUB_TOOL_IDS.contentRead,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.contentRead,
    inputSchema: issueInput({ path: contentPathProperty, ref: contentRefProperty }, ["path"]),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "path", "sha", "content", "encoding", "htmlUrl"],
      properties: {
        repository: repositoryProperty,
        path: { type: "string" },
        sha: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string" },
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
  "aaaaaaaa-000f-4000-8000-00000000000f",
  "github-content-read"
);

const contentList = publish(
  {
    toolId: GITHUB_TOOL_IDS.contentList,
    toolVersion: TOOL_VERSION,
    action: GITHUB_TOOL_IDS.contentList,
    inputSchema: issueInput({ path: contentPathProperty, ref: contentRefProperty }, []),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "path", "entries"],
      properties: {
        repository: repositoryProperty,
        path: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "path", "type", "sha", "htmlUrl"],
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              type: { type: "string", enum: ["file", "dir", "symlink", "submodule"] },
              sha: { type: "string" },
              htmlUrl: { type: "string" },
            },
          },
        },
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
  "aaaaaaaa-0010-4000-8000-000000000010",
  "github-content-list"
);

export const CONTENT_TOOL_CONTRACTS: readonly ToolContractDefinition[] = [contentRead, contentList];
