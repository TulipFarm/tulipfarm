import { githubExternalSubject, parseRepositoryRef } from "./scope";

/** Normalize only HMAC-verified, delivery-deduped GitHub webhooks; reject missing auth bounds. */

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

export const GITHUB_PULL_REQUEST_ACTIONS = [
  "opened",
  "edited",
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "review_requested",
  "review_request_removed",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
] as const;
export type GitHubPullRequestAction = (typeof GITHUB_PULL_REQUEST_ACTIONS)[number];

export interface GitHubPullRequestEvent {
  readonly action: GitHubPullRequestAction;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly repositoryRef: string;
  readonly installationId: string;
  readonly pullRequest: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly state: string;
    readonly htmlUrl: string;
    readonly merged: boolean;
    readonly headRef: string;
    readonly headSha: string;
    readonly baseRef: string;
    readonly labels: readonly string[];
  };
  readonly sender: { readonly login: string; readonly externalId: string };
}

export function normalizeGitHubPullRequestEvent(payload: unknown): GitHubPullRequestEvent {
  const root = requiredObject(payload);

  const action = requiredString(root.action);
  if (!(GITHUB_PULL_REQUEST_ACTIONS as readonly string[]).includes(action)) {
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
  const pullRequest = requiredObject(root.pull_request);
  const head = requiredObject(pullRequest.head);
  const base = requiredObject(pullRequest.base);

  return {
    action: action as GitHubPullRequestAction,
    repository: parsed,
    repositoryRef: ref,
    installationId,
    pullRequest: {
      number: requiredNumber(pullRequest.number),
      title: requiredString(pullRequest.title),
      body: typeof pullRequest.body === "string" ? pullRequest.body : "",
      state: requiredString(pullRequest.state),
      htmlUrl: requiredString(pullRequest.html_url),
      merged: pullRequest.merged === true,
      headRef: requiredString(head.ref),
      headSha: requiredString(head.sha),
      baseRef: requiredString(base.ref),
      labels: labelNames(pullRequest.labels),
    },
    sender: { login: requiredString(sender.login), externalId: requiredId(sender.id) },
  };
}

export interface GitHubPushCommit {
  readonly id: string;
  readonly message: string;
  readonly url: string;
}

export interface GitHubPushEvent {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly repositoryRef: string;
  readonly installationId: string;
  readonly ref: string;
  readonly before: string;
  readonly after: string;
  readonly forced: boolean;
  readonly deleted: boolean;
  readonly commits: readonly GitHubPushCommit[];
  readonly sender: { readonly login: string; readonly externalId: string };
}

/** Push has no `action`; `ref`/`commits` without `action` is the signal. */
export function normalizeGitHubPushEvent(payload: unknown): GitHubPushEvent {
  const root = requiredObject(payload);
  if (typeof root.action === "string") throw new GitHubEventError("malformed_payload");

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
  const commits = root.commits;
  if (!Array.isArray(commits)) throw new GitHubEventError("malformed_payload");

  return {
    repository: parsed,
    repositoryRef: ref,
    installationId,
    ref: requiredString(root.ref),
    before: requiredString(root.before),
    after: requiredString(root.after),
    forced: root.forced === true,
    deleted: root.deleted === true,
    commits: commits.map((commit) => {
      const entry = requiredObject(commit);
      return {
        id: requiredString(entry.id),
        message: requiredString(entry.message),
        url: requiredString(entry.url),
      };
    }),
    sender: { login: requiredString(sender.login), externalId: requiredId(sender.id) },
  };
}

export const GITHUB_CHECK_RUN_ACTIONS = [
  "created",
  "completed",
  "rerequested",
  "requested_action",
] as const;
export type GitHubCheckRunAction = (typeof GITHUB_CHECK_RUN_ACTIONS)[number];

export interface GitHubCheckRunEvent {
  readonly action: GitHubCheckRunAction;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly repositoryRef: string;
  readonly installationId: string;
  readonly checkRun: {
    readonly id: number;
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly htmlUrl: string;
    readonly headSha: string;
  };
  readonly sender: { readonly login: string; readonly externalId: string };
}

export function normalizeGitHubCheckRunEvent(payload: unknown): GitHubCheckRunEvent {
  const root = requiredObject(payload);

  const action = requiredString(root.action);
  if (!(GITHUB_CHECK_RUN_ACTIONS as readonly string[]).includes(action)) {
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
  const checkRun = requiredObject(root.check_run);

  return {
    action: action as GitHubCheckRunAction,
    repository: parsed,
    repositoryRef: ref,
    installationId,
    checkRun: {
      id: requiredNumber(checkRun.id),
      name: requiredString(checkRun.name),
      status: requiredString(checkRun.status),
      conclusion: typeof checkRun.conclusion === "string" ? checkRun.conclusion : null,
      htmlUrl: requiredString(checkRun.html_url),
      headSha: requiredString(checkRun.head_sha),
    },
    sender: { login: requiredString(sender.login), externalId: requiredId(sender.id) },
  };
}
