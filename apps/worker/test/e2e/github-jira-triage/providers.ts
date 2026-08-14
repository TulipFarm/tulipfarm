import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  IntegrationHttpPort,
  IntegrationHttpRequest,
  IntegrationHttpResponse,
} from "@tulipfarm/integrations";

/** Provider fakes: no hidden idempotency, phase-aware faults, and credential checks. */

const REPOSITORY = "tulip/farm";
const JIRA_PROJECT = "ENG";

export interface SeedIssueInput {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
}

export interface GitHubIssueState {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly state: "open" | "closed";
  readonly stateReason?: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export interface GitHubCommentState {
  readonly id: string;
  readonly issueNumber: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface JiraIssueState {
  readonly id: string;
  readonly key: string;
  readonly projectKey: string;
  readonly summary: string;
  readonly description: string;
  readonly issueType: string;
  readonly labels: readonly string[];
  readonly status: string;
  readonly assignee: string | null;
}

interface Fault {
  readonly status: number;
  /** True when the write lands before the failure — the ambiguous case. */
  readonly apply: boolean;
}

function json(status: number, body: unknown): IntegrationHttpResponse {
  return { status, headers: {}, body };
}

function route(request: IntegrationHttpRequest): string {
  return `${request.method} ${request.path}`;
}

function objectBody(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Queued faults fire once; `offline` fires until cleared. */
abstract class FaultInjectingProvider {
  /** Every request fails while true — a provider outage, not a single lost response. */
  offline = false;

  private readonly faults = new Map<string, Fault>();

  /** The mutation lands and the response is then lost: the caller cannot tell it applied. */
  applyThenFail(routeKey: string, status: number): void {
    this.faults.set(routeKey, { status, apply: true });
  }

  /** The provider rejects before acting: the write never happened. */
  failNext(routeKey: string, status: number): void {
    this.faults.set(routeKey, { status, apply: false });
  }

  protected takeFault(routeKey: string): Fault | undefined {
    const fault = this.faults.get(routeKey);
    if (fault !== undefined) this.faults.delete(routeKey);
    return fault;
  }
}

export class GitHubProvider extends FaultInjectingProvider implements IntegrationHttpPort {
  private readonly issueRecords = new Map<number, GitHubIssueState>();
  private readonly commentRecords: GitHubCommentState[] = [];
  private readonly mutationLog: string[] = [];
  private counter = 0;

  constructor(private readonly credential: string) {
    super();
  }

  seedIssue(input: SeedIssueInput): void {
    this.issueRecords.set(input.number, {
      ...input,
      state: "open",
      labels: [],
      assignees: [],
    });
  }

  issue(number: number): GitHubIssueState {
    const record = this.issueRecords.get(number);
    if (record === undefined) throw new Error(`unseeded github issue ${number}`);
    return record;
  }

  comments(issueNumber: number): GitHubCommentState[] {
    return this.commentRecords.filter((comment) => comment.issueNumber === issueNumber);
  }

  /** Every write this provider actually performed, in order. */
  mutations(): string[] {
    return [...this.mutationLog];
  }

  async send(
    request: IntegrationHttpRequest,
    credential: string
  ): Promise<IntegrationHttpResponse> {
    if (credential !== this.credential) return json(401, { message: "Bad credentials" });
    if (this.offline) return json(503, { message: "unavailable" });

    const key = route(request);
    const fault = this.takeFault(key);
    if (fault !== undefined && !fault.apply) return json(fault.status, { message: "failed" });
    const response = this.handle(request);
    if (fault !== undefined) return json(fault.status, { message: "failed" });
    return response;
  }

  private handle(request: IntegrationHttpRequest): IntegrationHttpResponse {
    const path = request.path;
    if (request.method === "GET" && path === "/search/issues") {
      return this.search(request.query?.q ?? "");
    }

    const comments = /^\/repos\/(.+)\/issues\/(\d+)\/comments$/.exec(path);
    if (comments !== null) {
      const number = Number(comments[2]);
      if (request.method === "GET") return this.listComments(number);
      if (request.method === "POST") return this.addComment(request, number);
    }

    const labels = /^\/repos\/(.+)\/issues\/(\d+)\/labels$/.exec(path);
    if (labels !== null && request.method === "POST") {
      return this.addLabels(request, Number(labels[2]));
    }

    const assignees = /^\/repos\/(.+)\/issues\/(\d+)\/assignees$/.exec(path);
    if (assignees !== null && request.method === "POST") {
      return this.addAssignees(request, Number(assignees[2]));
    }

    const issue = /^\/repos\/(.+)\/issues\/(\d+)$/.exec(path);
    if (issue !== null) {
      const number = Number(issue[2]);
      if (request.method === "GET") return this.readIssue(number);
      if (request.method === "PATCH") return this.patchIssue(request, number);
    }

    return json(404, { message: "Not Found" });
  }

  private issueBody(record: GitHubIssueState): Record<string, unknown> {
    return {
      number: record.number,
      title: record.title,
      body: record.body,
      state: record.state,
      state_reason: record.stateReason ?? null,
      html_url: `https://github.com/${REPOSITORY}/issues/${record.number}`,
      labels: record.labels.map((name) => ({ name })),
      assignees: record.assignees.map((login) => ({ login })),
    };
  }

  private readIssue(number: number): IntegrationHttpResponse {
    const record = this.issueRecords.get(number);
    return record === undefined
      ? json(404, { message: "Not Found" })
      : json(200, this.issueBody(record));
  }

  /** Excludes the subject issue: an issue is never its own duplicate candidate. */
  private search(query: string): IntegrationHttpResponse {
    const free = query
      .split(" ")
      .filter((term) => !term.includes(":"))
      .join(" ");
    const items = [...this.issueRecords.values()]
      .filter((record) => record.title !== free)
      .map((record) => ({
        repository_url: `https://api.github.com/repos/${REPOSITORY}`,
        number: record.number,
        title: record.title,
        state: record.state,
        html_url: `https://github.com/${REPOSITORY}/issues/${record.number}`,
      }));
    return json(200, { total_count: items.length, items });
  }

  private listComments(issueNumber: number): IntegrationHttpResponse {
    return json(
      200,
      this.comments(issueNumber).map((comment) => ({
        id: comment.id,
        body: comment.body,
        html_url: `https://github.com/${REPOSITORY}/issues/${issueNumber}#issuecomment-${comment.id}`,
        created_at: comment.createdAt,
      }))
    );
  }

  private addComment(
    request: IntegrationHttpRequest,
    issueNumber: number
  ): IntegrationHttpResponse {
    if (!this.issueRecords.has(issueNumber)) return json(404, { message: "Not Found" });
    const body = String(objectBody(request.body).body ?? "");
    const comment: GitHubCommentState = {
      id: String(++this.counter),
      issueNumber,
      body,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    this.commentRecords.push(comment);
    this.mutationLog.push(route(request));
    return json(201, {
      id: comment.id,
      body: comment.body,
      html_url: `https://github.com/${REPOSITORY}/issues/${issueNumber}#issuecomment-${comment.id}`,
      created_at: comment.createdAt,
    });
  }

  private addLabels(request: IntegrationHttpRequest, issueNumber: number): IntegrationHttpResponse {
    const record = this.issueRecords.get(issueNumber);
    if (record === undefined) return json(404, { message: "Not Found" });
    const added = stringList(objectBody(request.body).labels);
    const labels = [...new Set([...record.labels, ...added])];
    this.issueRecords.set(issueNumber, { ...record, labels });
    this.mutationLog.push(route(request));
    return json(
      200,
      labels.map((name) => ({ name }))
    );
  }

  private addAssignees(
    request: IntegrationHttpRequest,
    issueNumber: number
  ): IntegrationHttpResponse {
    const record = this.issueRecords.get(issueNumber);
    if (record === undefined) return json(404, { message: "Not Found" });
    const added = stringList(objectBody(request.body).assignees);
    const assignees = [...new Set([...record.assignees, ...added])];
    const updated = { ...record, assignees };
    this.issueRecords.set(issueNumber, updated);
    this.mutationLog.push(route(request));
    return json(201, this.issueBody(updated));
  }

  private patchIssue(
    request: IntegrationHttpRequest,
    issueNumber: number
  ): IntegrationHttpResponse {
    const record = this.issueRecords.get(issueNumber);
    if (record === undefined) return json(404, { message: "Not Found" });
    const body = objectBody(request.body);
    const updated: GitHubIssueState = {
      ...record,
      state: body.state === "closed" ? "closed" : record.state,
      stateReason: typeof body.state_reason === "string" ? body.state_reason : record.stateReason,
    };
    this.issueRecords.set(issueNumber, updated);
    this.mutationLog.push(route(request));
    return json(200, this.issueBody(updated));
  }
}

export class JiraProvider extends FaultInjectingProvider implements IntegrationHttpPort {
  private readonly issueRecords: JiraIssueState[] = [];
  private readonly mutationLog: string[] = [];
  private counter = 0;

  constructor(
    private readonly credential: string,
    readonly siteUrl: string
  ) {
    super();
  }

  issues(): JiraIssueState[] {
    return [...this.issueRecords];
  }

  mutations(): string[] {
    return [...this.mutationLog];
  }

  async send(
    request: IntegrationHttpRequest,
    credential: string
  ): Promise<IntegrationHttpResponse> {
    if (credential !== this.credential) return json(401, { message: "Unauthorized" });
    if (this.offline) return json(503, { message: "unavailable" });

    const key = route(request);
    const fault = this.takeFault(key);
    if (fault !== undefined && !fault.apply) return json(fault.status, { message: "failed" });
    const response = this.handle(request);
    if (fault !== undefined) return json(fault.status, { message: "failed" });
    return response;
  }

  private handle(request: IntegrationHttpRequest): IntegrationHttpResponse {
    if (request.method === "GET" && request.path === "/rest/api/3/search") {
      return this.search(request.query?.jql ?? "");
    }
    if (request.method === "POST" && request.path === "/rest/api/3/issue") {
      return this.createIssue(request);
    }
    const issue = /^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]*-\d+)$/.exec(request.path);
    if (issue !== null && request.method === "GET") return this.readIssue(String(issue[1]));
    return json(404, { errorMessages: ["not found"] });
  }

  private issueBody(record: JiraIssueState): Record<string, unknown> {
    return {
      id: record.id,
      key: record.key,
      fields: {
        summary: record.summary,
        description: record.description,
        status: { name: record.status },
        issuetype: { name: record.issueType },
        assignee: record.assignee === null ? null : { accountId: record.assignee },
        labels: [...record.labels],
      },
    };
  }

  private readIssue(key: string): IntegrationHttpResponse {
    const record = this.issueRecords.find((issue) => issue.key === key);
    return record === undefined
      ? json(404, { errorMessages: ["not found"] })
      : json(200, this.issueBody(record));
  }

  /** Supports only adapter JQL shapes; unknown JQL matches nothing instead of guessing. */
  private search(jql: string): IntegrationHttpResponse {
    const label = /^labels = "(.+)"$/.exec(jql);
    const matched =
      label !== null
        ? this.issueRecords.filter((issue) => issue.labels.includes(String(label[1])))
        : this.assigneeSearch(jql);
    return json(200, {
      total: matched.length,
      startAt: 0,
      issues: matched.map((record) => this.issueBody(record)),
    });
  }

  private assigneeSearch(jql: string): JiraIssueState[] {
    const assignee = /assignee = "(.+?)"/.exec(jql);
    if (assignee === null) return [];
    return this.issueRecords.filter(
      (issue) => issue.assignee === String(assignee[1]) && issue.status !== "Done"
    );
  }

  private createIssue(request: IntegrationHttpRequest): IntegrationHttpResponse {
    const fields = objectBody(objectBody(request.body).fields);
    const projectKey = String(objectBody(fields.project).key ?? JIRA_PROJECT);
    const record: JiraIssueState = {
      id: String(10_000 + ++this.counter),
      key: `${projectKey}-${this.counter}`,
      projectKey,
      summary: String(fields.summary ?? ""),
      description: String(fields.description ?? ""),
      issueType: String(objectBody(fields.issuetype).name ?? "Task"),
      labels: stringList(fields.labels),
      status: "To Do",
      assignee: null,
    };
    this.issueRecords.push(record);
    this.mutationLog.push(route(request));
    return json(201, { id: record.id, key: record.key });
  }
}

export interface SignedDelivery {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** HMAC exactly as GitHub computes it, so a forged signature fails for the real reason. */
export function signGitHubDelivery(
  secret: string,
  deliveryId: string,
  payload: unknown
): SignedDelivery {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return {
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  };
}

export function verifyGitHubSignature(secret: string, delivery: SignedDelivery): boolean {
  const presented = delivery.headers["x-hub-signature-256"] ?? "";
  const expected = `sha256=${createHmac("sha256", secret).update(delivery.body, "utf8").digest("hex")}`;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
