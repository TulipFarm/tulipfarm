import {
  GITHUB_TOOL_IDS,
  githubEffectMarker,
  JIRA_TOOL_IDS,
  jiraEffectLabel,
} from "@tulipfarm/integrations";
import type { CompiledState } from "@tulipfarm/run-kernel";
import type { EffectRecord, ToolIntent } from "@tulipfarm/tool-broker";
import {
  BUSINESS_ID,
  JIRA_SITE_URL,
  REPOSITORY,
  record,
  type TriageResult,
  type TriageStep,
} from "./fixtures";
import type { GitHubProvider, JiraProvider } from "./providers";

/**
 * One walk through the triage Routine: what it carries, how each State is addressed from it, and
 * what it reads back.
 *
 * The addressing is the point. A State's effect id and idempotency key derive from the delivery id
 * and the State name alone, so a redelivery, a retry and a resume all land on the same reservation
 * — and when that reservation is already confirmed, `providerOutputFor` reads the outcome back out
 * of the provider instead of repeating an effect that has already happened.
 */

/** The two fake providers a confirmed effect is read back from. */
export interface TriageProviders {
  readonly github: GitHubProvider;
  readonly jira: JiraProvider;
}

/** Duplicate reservations read provider state instead of repeating confirmed effects. */
export function providerOutputFor(
  providers: TriageProviders,
  effect: EffectRecord
): Record<string, unknown> | undefined {
  const { github, jira } = providers;
  const source = record(effect.intent.arguments);
  const key = effect.idempotencyKey;

  switch (effect.intent.action) {
    case GITHUB_TOOL_IDS.issueLabel:
      return { labels: [...github.issue(Number(source.issueNumber)).labels] };
    case GITHUB_TOOL_IDS.issueAssign:
      return { assignees: [...github.issue(Number(source.issueNumber)).assignees] };
    case GITHUB_TOOL_IDS.issueClose: {
      const issue = github.issue(Number(source.issueNumber));
      return { number: issue.number, state: issue.state, stateReason: issue.stateReason ?? "" };
    }
    case GITHUB_TOOL_IDS.issueComment: {
      const issueNumber = Number(source.issueNumber);
      const marker = githubEffectMarker(key);
      const comment = github.comments(issueNumber).find((entry) => entry.body.includes(marker));
      return comment === undefined
        ? undefined
        : {
            commentId: comment.id,
            htmlUrl: `https://github.com/${REPOSITORY}/issues/${issueNumber}#issuecomment-${comment.id}`,
            createdAt: comment.createdAt,
          };
    }
    case JIRA_TOOL_IDS.issueCreate: {
      const label = jiraEffectLabel(key);
      const issue = jira.issues().find((entry) => entry.labels.includes(label));
      return issue === undefined
        ? undefined
        : { issueKey: issue.key, issueId: issue.id, url: `${JIRA_SITE_URL}/browse/${issue.key}` };
    }
    default:
      return undefined;
  }
}

export function citationsFor(state: CompiledState, output: unknown): string[] {
  const value = record(output);
  switch (state.name) {
    case "ReadIssue":
      return [`github:issue:${String(value.repository)}#${String(value.number)}`];
    case "FindDuplicates":
      return (Array.isArray(value.items) ? value.items : []).map((entry) => {
        const item = record(entry);
        return `github:issue:${String(item.repository)}#${String(item.number)}`;
      });
    case "CreateTicket":
      return [`jira:issue:${String(value.issueKey)}`];
    case "ReplyDuplicate":
    case "ReplyTriaged":
      return [`github:comment:${String(value.commentId)}`];
    default:
      return [];
  }
}

export interface WalkState {
  readonly deliveryId: string;
  readonly issueNumber: number;
  readonly mode: "start" | "resume";
  readonly steps: TriageStep[];
  readonly citations: string[];
  readonly outputs: Record<string, unknown>;
  /** Effects reserved by consuming an Approval, keyed by the gated State they authorize. */
  readonly preReserved: Map<string, { readonly effectId: string; readonly created: boolean }>;
}

export function scopeOf(walk: WalkState): Record<string, unknown> {
  return {
    trigger: { repositoryRef: REPOSITORY, issueNumber: walk.issueNumber },
    states: walk.outputs,
    input: {},
  };
}

export function inputsFor(state: CompiledState, walk: WalkState): Record<string, unknown> {
  const scope = scopeOf(walk);
  const input: Record<string, unknown> = {};
  for (const mapping of state.inputs) {
    input[mapping.name] =
      mapping.expression === null ? mapping.literal : mapping.expression.evaluate(scope);
  }
  return input;
}

export function blocked(walk: WalkState, reason?: string): TriageResult {
  return {
    outcome: "blocked",
    deliveryId: walk.deliveryId,
    issueNumber: walk.issueNumber,
    steps: walk.steps,
    citations: walk.citations,
    ...(reason === undefined ? {} : { blockedReason: reason }),
  };
}

export function effectIdFor(walk: WalkState, stateName: string): string {
  return `effect-${walk.deliveryId}-${stateName}`;
}

export function reserveInputFor(
  state: CompiledState,
  walk: WalkState,
  intent: ToolIntent,
  createdAt: string
) {
  return {
    effectId: effectIdFor(walk, state.name),
    businessId: BUSINESS_ID,
    runId: intent.runId,
    stateId: state.name,
    logicalEffectOrdinal: state.index,
    idempotencyKey: intent.idempotencyKey,
    createdAt,
  };
}
