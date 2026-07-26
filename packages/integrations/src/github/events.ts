import { githubExternalSubject, parseRepositoryRef } from "./scope";

/**
 * GitHub webhook normalization (SPEC §9.2, §15).
 *
 * GitHub delivers signed webhooks, so this Integration never polls with a stored credential. The
 * ingress verifies the HMAC and deduplicates on the delivery id *before* anything here runs; this
 * module only projects a verified payload onto the typed event the Trigger layer consumes.
 * A payload that cannot be fully identified — no repository, no installation, no sender — is
 * rejected rather than defaulted, because each of those fields bounds a later authorization
 * decision. Denials carry a code only, never payload content.
 */

export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
export const GITHUB_DELIVERY_HEADER = "x-github-delivery";

export interface GitHubWebhookVerification {
  readonly method: "hmac_sha256";
  readonly secretRef: string;
  readonly signatureHeader: string;
  readonly signatureFormat: string;
}

export function githubWebhookVerification(secretRef: string): GitHubWebhookVerification {
  return {
    method: "hmac_sha256",
    secretRef,
    signatureHeader: GITHUB_SIGNATURE_HEADER,
    signatureFormat: "sha256={signature}",
  };
}

export type GitHubEventErrorCode = "malformed_payload" | "unsupported_action";

export class GitHubEventError extends Error {
  readonly name = "GitHubEventError";

  constructor(readonly code: GitHubEventErrorCode) {
    super(`github_event_rejected:${code}`);
  }
}

export const GITHUB_ISSUE_ACTIONS = [
  "opened",
  "edited",
  "reopened",
  "closed",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
] as const;
export type GitHubIssueAction = (typeof GITHUB_ISSUE_ACTIONS)[number];

export interface GitHubIssueEvent {
  readonly action: GitHubIssueAction;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly repositoryRef: string;
  readonly installationId: string;
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly state: string;
    readonly htmlUrl: string;
    readonly labels: readonly string[];
  };
  readonly sender: { readonly login: string; readonly externalId: string };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredObject(value: unknown): Record<string, unknown> {
  const result = object(value);
  if (result === undefined) throw new GitHubEventError("malformed_payload");
  return result;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubEventError("malformed_payload");
  }
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GitHubEventError("malformed_payload");
  }
  return value;
}

/** Stringify a provider id without asserting whether it arrived as a number or a string. */
function requiredId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return requiredString(value);
}

function labelNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GitHubEventError("malformed_payload");
  return value.map((label) => requiredString(requiredObject(label).name));
}

export function normalizeGitHubIssueEvent(payload: unknown): GitHubIssueEvent {
  const root = requiredObject(payload);

  const action = requiredString(root.action);
  if (!(GITHUB_ISSUE_ACTIONS as readonly string[]).includes(action)) {
    throw new GitHubEventError("unsupported_action");
  }

  const repository = requiredObject(root.repository);
  const ref = requiredString(repository.full_name);
  const parsed = (() => {
    try {
      return parseRepositoryRef(ref);
    } catch {
      throw new GitHubEventError("malformed_payload");
    }
  })();

  const installationId = requiredId(requiredObject(root.installation).id);
  const sender = requiredObject(root.sender);
  const issue = requiredObject(root.issue);

  return {
    action: action as GitHubIssueAction,
    repository: parsed,
    repositoryRef: ref,
    installationId,
    issue: {
      number: requiredNumber(issue.number),
      title: requiredString(issue.title),
      // A GitHub issue with no description sends `body: null`; keep the field, drop the null.
      body: typeof issue.body === "string" ? issue.body : "",
      state: requiredString(issue.state),
      htmlUrl: requiredString(issue.html_url),
      labels: labelNames(issue.labels),
    },
    sender: { login: requiredString(sender.login), externalId: requiredId(sender.id) },
  };
}

/** Subject to look the sender up by in the external identity map. */
export function githubSenderSubject(event: GitHubIssueEvent): string {
  return githubExternalSubject(event.sender.externalId);
}
