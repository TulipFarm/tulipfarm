import { createHash } from "node:crypto";
import { GITHUB_TOOL_CONTRACTS, GITHUB_TOOL_IDS, type GitHubToolId } from "@tulipfarm/integrations";
import {
  EffectDispatcher,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  ToolCatalog,
  ToolDispatchError,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import { err, ok, type RequestContext, type ToolCallResult, type ToolDef } from "../types";
import type { GitHubTooling } from "./compose";
import { GITHUB_INSTALLATION_SECRET_REF } from "./credentials";

/**
 * The chat-facing GitHub Tool family — one `ToolDef` per `GITHUB_TOOL_CONTRACTS` entry, tier
 * `"integration"`. Every call goes through the same effect-ledger idempotency path a Routine's
 * `tool` State uses (`EffectStore.reserve` -> `EffectDispatcher.dispatch`), so a crash mid-call
 * never double-posts a comment or double-merges a PR. Approval gating is the existing chat-turn
 * coarse gate (`RegistryToolDispatcher.needsApproval`, keyed on `ToolDef.mutating`) — this family
 * does not re-derive a Broker-catalog/GuardrailPolicy authorization decision the way a Routine's
 * `tool` State does, per the scope decision in `docs/plans/2026-08-07-github-chat-tool-access.md`.
 */

const GITHUB_CATALOG = ToolCatalog.load(GITHUB_TOOL_CONTRACTS);

interface GitHubToolSpec {
  readonly name: string;
  readonly description: string;
}

const GITHUB_TOOL_SPECS: Record<GitHubToolId, GitHubToolSpec> = {
  [GITHUB_TOOL_IDS.issueRead]: {
    name: "github_issue_read",
    description: "Read one GitHub issue's title, body, state, labels, and assignees.",
  },
  [GITHUB_TOOL_IDS.issueSearch]: {
    name: "github_issue_search",
    description: "Search a GitHub repository's issues by query and state.",
  },
  [GITHUB_TOOL_IDS.issueComment]: {
    name: "github_issue_comment",
    description: "Post a comment on a GitHub issue.",
  },
  [GITHUB_TOOL_IDS.issueLabel]: {
    name: "github_issue_label",
    description: "Set the labels on a GitHub issue.",
  },
  [GITHUB_TOOL_IDS.issueAssign]: {
    name: "github_issue_assign",
    description: "Set the assignees on a GitHub issue.",
  },
  [GITHUB_TOOL_IDS.issueClose]: {
    name: "github_issue_close",
    description: "Close a GitHub issue, optionally with a state reason.",
  },
  [GITHUB_TOOL_IDS.pullRequestRead]: {
    name: "github_pull_request_read",
    description: "Read one GitHub pull request's title, body, state, and branches.",
  },
  [GITHUB_TOOL_IDS.pullRequestSearch]: {
    name: "github_pull_request_search",
    description: "Search a GitHub repository's pull requests by query and state.",
  },
  [GITHUB_TOOL_IDS.pullRequestCreate]: {
    name: "github_pull_request_create",
    description: "Open a new GitHub pull request from a head branch into a base branch.",
  },
  [GITHUB_TOOL_IDS.pullRequestComment]: {
    name: "github_pull_request_comment",
    description: "Post a comment on a GitHub pull request.",
  },
  [GITHUB_TOOL_IDS.pullRequestReview]: {
    name: "github_pull_request_review",
    description: "Submit a review (approve, request changes, or comment) on a GitHub pull request.",
  },
  [GITHUB_TOOL_IDS.pullRequestMerge]: {
    name: "github_pull_request_merge",
    description: "Merge a GitHub pull request.",
  },
  [GITHUB_TOOL_IDS.checkRunRead]: {
    name: "github_check_run_read",
    description: "Read one GitHub check run's status and conclusion.",
  },
  [GITHUB_TOOL_IDS.repoPush]: {
    name: "github_repo_push",
    description: "Commit one or more files to a GitHub branch.",
  },
  [GITHUB_TOOL_IDS.contentRead]: {
    name: "github_content_read",
    description: "Read a file's contents from a GitHub repository.",
  },
  [GITHUB_TOOL_IDS.contentList]: {
    name: "github_content_list",
    description: "List a directory's contents in a GitHub repository (or the repository root).",
  },
};

/** Dresses a digest as an RFC 4122 v4 uuid, same technique run-kernel uses for durable effect ids. */
function derivedId(...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex");
  const version = `4${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function mapDispatchError(error: ToolDispatchError): ToolCallResult {
  if (error.code === "invalid_output")
    return err("internal_error", "GitHub returned an unexpected response shape");
  if (error.detail === "integration_context_unresolved") {
    return err(
      "not_found",
      "No active GitHub installation covers that repository. Call github_repository_list to see " +
        "which repositories are installed, then retry with one of those."
    );
  }
  return err("internal_error", error.detail ? `${error.code}:${error.detail}` : error.message);
}

/**
 * A rediscovered effect from an earlier attempt at this exact call (same run + call id) — the
 * ledger keeps only whether it landed, not the GitHub response body, so a replay can't hand the
 * model the original output back. Mirrors `apps/worker/src/routine/tool-port.ts`'s `replayed()`:
 * `confirmed` is success without repeating the call, anything else is a definitive negative.
 */
function replayed(state: string): ToolCallResult {
  switch (state) {
    case "confirmed":
      return ok({ replayed: true, note: "This action already completed; not repeated." });
    case "denied":
      return err("internal_error", "effect_denied");
    case "failed":
      return err("internal_error", "effect_failed");
    default:
      return err("internal_error", `effect_${state}`);
  }
}

function buildToolDef(
  toolId: GitHubToolId,
  businessId: string,
  tooling: GitHubToolingContext
): ToolDef {
  const contract = GITHUB_CATALOG.get(toolId, "1.0.0");
  if (contract === undefined) {
    throw new Error(`github tool contract not published: ${toolId}`);
  }
  const spec = GITHUB_TOOL_SPECS[toolId];

  return {
    name: spec.name,
    tier: "integration",
    mutating: contract.mutating,
    description: spec.description,
    inputSchema: contract.inputSchema,
    async execute(args, ctx: RequestContext): Promise<ToolCallResult> {
      const runId = ctx.runId;
      if (runId === undefined) return err("internal_error", "no run context for this tool call");
      // Falls back to a fresh call identity when none is supplied (e.g. a direct registry test) —
      // idempotency then only holds within this one call, not across a crash/replay, which is the
      // same guarantee a non-integration ToolDef already gives.
      const callId = ctx.toolCallId ?? crypto.randomUUID();
      const stateId = `invoke:${callId}`;

      const rawIntent: ToolIntent = {
        intentId: derivedId("github-intent", runId, stateId, toolId),
        businessId,
        runId,
        stateId,
        toolId,
        toolVersion: contract.toolVersion,
        action: toolId,
        targetRefs: [],
        arguments: args,
        credentialRef: GITHUB_INSTALLATION_SECRET_REF,
        idempotencyKey: derivedId("github-idempotency", runId, stateId, toolId),
      };
      const intent = normalizeToolIntent(rawIntent);
      const effectId = derivedId("github-effect", runId, stateId, toolId);

      const reserved = await tooling.effects.reserve({
        effectId,
        businessId,
        runId,
        stateId,
        logicalEffectOrdinal: 0,
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        intent,
        guardrailRevision: ctx.guardrailRevision ?? "none",
        createdAt: new Date().toISOString(),
      });

      if (reserved.outcome === "duplicate") return replayed(reserved.effect.state);

      const dispatcher = new EffectDispatcher({
        store: tooling.effects,
        catalog: GITHUB_CATALOG,
        adapters: tooling.adapters,
        credentialDispatcher: tooling.credentials,
      });

      try {
        const output = await dispatcher.dispatch(businessId, reserved.effect.effectId);
        return ok(output);
      } catch (error) {
        if (error instanceof ToolDispatchError) return mapDispatchError(error);
        throw error;
      }
    },
  };
}

const EMPTY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const GITHUB_REPOSITORY_LIST_TOOL_NAME = "github_repository_list";

/**
 * Local-only discovery tool: no GitHub API call, no effect ledger reservation — it just projects
 * this business's active installations. Every other GitHub tool requires an `owner/repo` argument
 * the model otherwise has no way to learn (see `context.ts`'s `integration_context_unresolved`),
 * so this is what lets the model resolve "my github issues" into a concrete repository first.
 */
function buildRepositoryListTool(tooling: GitHubTooling): ToolDef {
  return {
    name: GITHUB_REPOSITORY_LIST_TOOL_NAME,
    tier: "integration",
    mutating: false,
    description:
      "List the GitHub repositories this business has an active installation for. Call this " +
      "first when the user names no repository, or names one you're not sure is installed.",
    inputSchema: EMPTY_SCHEMA,
    async execute(): Promise<ToolCallResult> {
      const installations = await tooling.installations.list();
      const repositories = installations.flatMap((installation) =>
        installation.repositories.map((repository) => ({
          repository,
          account: installation.accountLogin,
          permissions: installation.permissions,
        }))
      );
      return ok({ repositories });
    },
  };
}

export interface GitHubToolingContext extends GitHubTooling {
  readonly effects: EffectStore;
}

export function buildGitHubTools(businessId: string, tooling: GitHubToolingContext): ToolDef[] {
  return [
    buildRepositoryListTool(tooling),
    ...GITHUB_TOOL_CONTRACTS.map((contract) =>
      buildToolDef(contract.spec.toolId as GitHubToolId, businessId, tooling)
    ),
  ];
}

/** Every chat tool name this family registers — the set excluded from a turn's allowlist while
 * GitHub is not installed (see `tools/github/visibility.ts`). Independent of any built `ToolDef[]`
 * so the exclusion can be computed without a live tooling composition. */
export const GITHUB_TOOL_NAMES: ReadonlySet<string> = new Set([
  GITHUB_REPOSITORY_LIST_TOOL_NAME,
  ...Object.values(GITHUB_TOOL_SPECS).map((spec) => spec.name),
]);
