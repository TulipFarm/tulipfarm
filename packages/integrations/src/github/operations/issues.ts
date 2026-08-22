import {
  type Arguments,
  type GitHubApi,
  githubEffectMarker,
  list,
  logins,
  names,
  numberArg,
  optionalStringArg,
  record,
  searchOutput,
  stringArg,
  stringListArg,
} from "./shared";

export function issueOutput(repository: string, issue: Record<string, unknown>): unknown {
  return {
    repository,
    number: Number(issue.number),
    title: String(issue.title),
    body: typeof issue.body === "string" ? issue.body : "",
    state: String(issue.state),
    labels: names(issue.labels),
    assignees: logins(issue.assignees),
    htmlUrl: String(issue.html_url),
  };
}

export function commentOutput(comment: Record<string, unknown>): unknown {
  return {
    commentId: String(comment.id),
    htmlUrl: String(comment.html_url),
    createdAt: String(comment.created_at),
  };
}

export async function readIssue(
  api: GitHubApi,
  repository: string,
  issueNumber: number,
  credential: string
): Promise<unknown> {
  const response = await api.call(
    { method: "GET", path: `/repos/${repository}/issues/${issueNumber}` },
    credential,
    false
  );
  return issueOutput(repository, record(response.body));
}

/** The raw provider issue, used by reconciliation to read state, labels and assignees. */
export async function issueState(
  api: GitHubApi,
  repository: string,
  issueNumber: number,
  credential: string
): Promise<Record<string, unknown>> {
  const response = await api.call(
    { method: "GET", path: `/repos/${repository}/issues/${issueNumber}` },
    credential,
    false
  );
  return record(response.body);
}

export async function searchIssues(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  credential: string
): Promise<unknown> {
  const state = typeof source.state === "string" ? source.state : "open";
  const qualifiers = [`repo:${repository}`, "is:issue"];
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

export async function findMarkedComment(
  api: GitHubApi,
  repository: string,
  issueNumber: number,
  marker: string,
  credential: string
): Promise<Record<string, unknown> | undefined> {
  const response = await api.call(
    { method: "GET", path: `/repos/${repository}/issues/${issueNumber}/comments` },
    credential,
    false
  );
  return list(response.body)
    .map((entry) => record(entry))
    .find((comment) => String(comment.body ?? "").includes(marker));
}

/** GitHub's `/issues` list endpoint also returns pull requests, but the marker is unique. */
export async function findMarkedIssue(
  api: GitHubApi,
  repository: string,
  marker: string,
  credential: string
): Promise<Record<string, unknown> | undefined> {
  const response = await api.call(
    {
      method: "GET",
      path: `/repos/${repository}/issues`,
      query: { state: "all", per_page: "100" },
    },
    credential,
    false
  );
  return list(response.body)
    .map((entry) => record(entry))
    .find((issue) => String(issue.body ?? "").includes(marker));
}

export async function comment(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  idempotencyKey: string,
  credential: string
): Promise<unknown> {
  const issueNumber = numberArg(source, "issueNumber");
  const marker = githubEffectMarker(idempotencyKey);

  // Read before write: a redelivered effect must return the comment it already posted.
  const existing = await findMarkedComment(api, repository, issueNumber, marker, credential);
  if (existing !== undefined) return commentOutput(existing);

  const response = await api.call(
    {
      method: "POST",
      path: `/repos/${repository}/issues/${issueNumber}/comments`,
      body: { body: `${stringArg(source, "body")}\n\n${marker}` },
    },
    credential,
    true
  );
  return commentOutput(record(response.body));
}

export async function addLabels(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  credential: string
): Promise<unknown> {
  const response = await api.call(
    {
      method: "POST",
      path: `/repos/${repository}/issues/${numberArg(source, "issueNumber")}/labels`,
      body: { labels: stringListArg(source, "labels") },
    },
    credential,
    true
  );
  return { labels: names(response.body) };
}

export async function assign(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  credential: string
): Promise<unknown> {
  const response = await api.call(
    {
      method: "POST",
      path: `/repos/${repository}/issues/${numberArg(source, "issueNumber")}/assignees`,
      body: { assignees: stringListArg(source, "assignees") },
    },
    credential,
    true
  );
  return { assignees: logins(record(response.body).assignees) };
}

export async function close(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  credential: string
): Promise<unknown> {
  const stateReason = typeof source.stateReason === "string" ? source.stateReason : "completed";
  const response = await api.call(
    {
      method: "PATCH",
      path: `/repos/${repository}/issues/${numberArg(source, "issueNumber")}`,
      body: { state: "closed", state_reason: stateReason },
    },
    credential,
    true
  );
  const issue = record(response.body);
  return {
    number: Number(issue.number),
    state: String(issue.state),
    stateReason: String(issue.state_reason),
  };
}

export async function createIssue(
  api: GitHubApi,
  repository: string,
  source: Arguments,
  idempotencyKey: string,
  credential: string
): Promise<unknown> {
  const marker = githubEffectMarker(idempotencyKey);

  // Read before write: a redelivered effect must return the issue it already opened.
  const existing = await findMarkedIssue(api, repository, marker, credential);
  if (existing !== undefined) return issueOutput(repository, existing);

  const body = typeof source.body === "string" ? source.body : "";
  const response = await api.call(
    {
      method: "POST",
      path: `/repos/${repository}/issues`,
      body: {
        title: stringArg(source, "title"),
        body: `${body}\n\n${marker}`,
        labels: Array.isArray(source.labels) ? stringListArg(source, "labels") : undefined,
        assignees: Array.isArray(source.assignees) ? stringListArg(source, "assignees") : undefined,
      },
    },
    credential,
    true
  );
  return issueOutput(repository, record(response.body));
}
