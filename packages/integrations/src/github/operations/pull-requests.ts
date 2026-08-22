import { commentOutput, findMarkedComment } from "./issues";
import {
  type Arguments,
  type GitHubApi,
  githubEffectMarker,
  list,
  numberArg,
  optionalStringArg,
  record,
  searchOutput,
  stringArg,
} from "./shared";

export function pullRequestOutput(repository: string, pr: Record<string, unknown>): unknown {
  return {
    repository,
    number: Number(pr.number),
    title: String(pr.title),
    body: typeof pr.body === "string" ? pr.body : "",
    state: String(pr.state),
    merged: pr.merged === true,
    htmlUrl: String(pr.html_url),
    headRef: String(record(pr.head).ref),
    baseRef: String(record(pr.base).ref),
  };
}

export function reviewOutput(review: Record<string, unknown>): unknown {
  return {
    reviewId: String(review.id),
    state: String(review.state),
    htmlUrl: String(review.html_url),
  };
}

export async function readPullRequest(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
  credential: string
): Promise<unknown> {
  const response = await api.call(
    { method: "GET", path: `/repos/${repository}/pulls/${pullNumber}` },
    credential,
    false
  );
  return pullRequestOutput(repository, record(response.body));
}

/** The raw provider pull request, used by reconciliation to read merge state. */
export async function pullRequestState(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
  credential: string
): Promise<Record<string, unknown>> {
  const response = await api.call(
    { method: "GET", path: `/repos/${repository}/pulls/${pullNumber}` },
    credential,
    false
  );
  return record(response.body);
}

export async function searchPullRequests(
  api: GitHubApi,
  repositories: readonly string[],
  source: Arguments,
  credential: string
): Promise<unknown> {
  const state = typeof source.state === "string" ? source.state : "open";
  const qualifiers = [...repositories.map((repository) => `repo:${repository}`), "is:pr"];
  if (state !== "all") qualifiers.push(`state:${state}`);
  const query = optionalStringArg(source, "query");
  if (query.length > 0) qualifiers.push(query);
  const response = await api.call(
    {
      method: "GET",
      path: "/search/issues",
      query: {
        q: qualifiers.join(" "),
        per_page: String(typeof source.limit === "number" ? source.limit : 20),
      },
    },
    credential,
    false
  );
  return searchOutput(record(response.body));
}

export async function findOpenPullRequestByHead(
  api: GitHubApi,
  repository: string,
  head: string,
  credential: string
): Promise<Record<string, unknown> | undefined> {
  const owner = repository.split("/")[0];
  const response = await api.call(
    {
      method: "GET",
      path: `/repos/${repository}/pulls`,
      query: { head: `${owner}:${head}`, state: "open" },
    },
    credential,
    false
  );
  const [first] = list(response.body).map((entry) => record(entry));
  return first;
}

export async function createPullRequest(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  idempotencyKey: string,
  credential: string
): Promise<unknown> {
  const head = stringArg(source, "head");
  const base = stringArg(source, "base");
  const marker = githubEffectMarker(idempotencyKey);

  // Read before write: a redelivered effect must return the PR it already opened.
  const existing = await findOpenPullRequestByHead(api, repository, head, credential);
  if (existing !== undefined) return pullRequestOutput(repository, existing);

  const body = typeof source.body === "string" ? source.body : "";
  const response = await api.call(
    {
      method: "POST",
      path: `/repos/${repository}/pulls`,
      body: {
        title: stringArg(source, "title"),
        body: `${body}\n\n${marker}`,
        head,
        base,
        draft: source.draft === true,
      },
    },
    credential,
    true
  );
  return pullRequestOutput(repository, record(response.body));
}

export async function pullRequestComment(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  idempotencyKey: string,
  credential: string
): Promise<unknown> {
  const pullNumber = numberArg(source, "pullNumber");
  const marker = githubEffectMarker(idempotencyKey);

  // PR comments are issue comments under the hood — same endpoint, same marker convention.
  const existing = await findMarkedComment(api, repository, pullNumber, marker, credential);
  if (existing !== undefined) return commentOutput(existing);

  const response = await api.call(
    {
      method: "POST",
      path: `/repos/${repository}/issues/${pullNumber}/comments`,
      body: { body: `${stringArg(source, "body")}\n\n${marker}` },
    },
    credential,
    true
  );
  return commentOutput(record(response.body));
}

export async function findMarkedReview(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
  marker: string,
  credential: string
): Promise<Record<string, unknown> | undefined> {
  const response = await api.call(
    { method: "GET", path: `/repos/${repository}/pulls/${pullNumber}/reviews` },
    credential,
    false
  );
  return list(response.body)
    .map((entry) => record(entry))
    .find((review) => String(review.body ?? "").includes(marker));
}

export async function review(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  idempotencyKey: string,
  credential: string
): Promise<unknown> {
  const pullNumber = numberArg(source, "pullNumber");
  const marker = githubEffectMarker(idempotencyKey);

  const existing = await findMarkedReview(api, repository, pullNumber, marker, credential);
  if (existing !== undefined) return reviewOutput(existing);

  const body = typeof source.body === "string" ? source.body : "";
  const response = await api.call(
    {
      method: "POST",
      path: `/repos/${repository}/pulls/${pullNumber}/reviews`,
      body: { event: stringArg(source, "event"), body: `${body}\n\n${marker}` },
    },
    credential,
    true
  );
  return reviewOutput(record(response.body));
}

export async function mergePullRequest(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  credential: string
): Promise<unknown> {
  const pullNumber = numberArg(source, "pullNumber");

  // Read before write: an already-merged PR must never be merged twice.
  const current = await pullRequestState(api, repository, pullNumber, credential);
  if (current.merged === true) {
    return { merged: true, sha: String(current.merge_commit_sha ?? "") };
  }

  const mergeMethod = typeof source.mergeMethod === "string" ? source.mergeMethod : "merge";
  const mergeBody: Record<string, unknown> = { merge_method: mergeMethod };
  if (typeof source.commitTitle === "string") mergeBody.commit_title = source.commitTitle;

  const response = await api.call(
    { method: "PUT", path: `/repos/${repository}/pulls/${pullNumber}/merge`, body: mergeBody },
    credential,
    true
  );
  const result = record(response.body);
  return { merged: result.merged === true, sha: String(result.sha ?? "") };
}
