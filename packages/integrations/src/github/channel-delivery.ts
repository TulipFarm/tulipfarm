import { createHash } from "node:crypto";
import type {
  ChannelDeliveryAttempt,
  ChannelDeliveryAuthorizationPort,
  ChannelDeliveryLedger,
  ChannelDeliveryRecord,
} from "../channels/ports";
import {
  classifyHttpFailure,
  type IntegrationHttpPort,
  type IntegrationHttpResponse,
} from "../http";
import { parseRepositoryRef } from "./scope";

export interface GitHubReplyCredential {
  readonly token: string;
  readonly botUserId: string;
}

export interface GitHubReplyRequest extends ChannelDeliveryAttempt {
  readonly threadId: string;
  readonly text: string;
}

export class GitHubReplyError extends Error {
  readonly name = "GitHubReplyError";

  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly retryAfterMs = 5000
  ) {
    super(`github_reply:${code}`);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageId(body: unknown, botUserId: string): string | undefined {
  const message = object(body);
  const author = object(message?.user);
  if (String(author?.id) !== botUserId || author?.type !== "Bot") return undefined;
  return typeof message?.id === "number" && Number.isSafeInteger(message.id) && message.id > 0
    ? String(message.id)
    : undefined;
}

/** Native replies only: no Tool registration or arbitrary GitHub operation dispatch. */
export class GitHubReplyDelivery {
  constructor(
    private readonly deps: {
      readonly ledger: ChannelDeliveryLedger;
      readonly authorization: ChannelDeliveryAuthorizationPort;
      readonly http: IntegrationHttpPort;
      readonly now?: () => number;
    }
  ) {}

  async deliver(
    request: GitHubReplyRequest,
    credential: GitHubReplyCredential
  ): Promise<ChannelDeliveryRecord> {
    if (request.provider !== "github") throw new GitHubReplyError("provider_mismatch");
    if (!/^[1-9]\d*$/.test(request.threadId)) throw new GitHubReplyError("thread_invalid");
    const repository = parseRepositoryRef(request.destination);
    const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/issues/${request.threadId}/comments`;
    if (!credential.token || !/^[1-9]\d*$/.test(credential.botUserId)) {
      throw new GitHubReplyError("credential_missing");
    }
    const marker = `<!-- tulipfarm-reply:${createHash("sha256")
      .update(JSON.stringify([request.businessId, request.integrationId, request.idempotencyKey]))
      .digest("hex")} -->`;
    const begun = await this.deps.ledger.begin(request);
    if (
      begun.record.businessId !== request.businessId ||
      begun.record.integrationId !== request.integrationId ||
      begun.record.routeId !== request.routeId ||
      begun.record.provider !== "github" ||
      begun.record.destination !== request.destination ||
      begun.record.principalId !== request.principalId ||
      begun.record.agentId !== request.agentId
    ) {
      throw new GitHubReplyError("delivery_binding_invalid");
    }
    if (begun.record.status === "confirmed") return begun.record;
    if ((await this.deps.authorization.authorize(request)) !== "allowed") {
      await this.deps.ledger.fail(request, { status: "revoked", code: "authorization_revoked" });
      throw new GitHubReplyError("authorization_revoked");
    }
    if (begun.outcome === "duplicate") {
      const now = this.deps.now?.() ?? Date.now();
      if (
        begun.record.status === "ambiguous" ||
        (begun.record.status === "pending" &&
          begun.record.updatedAt !== undefined &&
          Date.parse(begun.record.updatedAt) + 60_000 <= now)
      ) {
        return this.reconcile(request, credential, path, marker);
      }
      throw new GitHubReplyError(
        "delivery_in_progress",
        begun.record.status === "pending" || begun.record.status === "retry_wait",
        begun.record.nextAttemptAt === undefined
          ? 5000
          : Math.max(1000, Date.parse(begun.record.nextAttemptAt) - now)
      );
    }
    let response: IntegrationHttpResponse;
    try {
      response = await this.deps.http.send(
        { method: "POST", path, body: { body: `${request.text}\n\n${marker}` } },
        credential.token
      );
    } catch {
      await this.deps.ledger.fail(request, { status: "ambiguous", code: "provider_unavailable" });
      throw new GitHubReplyError("provider_unavailable", true);
    }
    const failure = classifyHttpFailure(response, true);
    if (failure !== null) {
      const retryable = failure.retryable || failure.code === "provider_unauthorized";
      await this.deps.ledger.fail(request, {
        status:
          failure.phase === "after_dispatch" ? "ambiguous" : retryable ? "retry_wait" : "failed",
        code: failure.code,
        ...(retryable ? { retryAfterMs: failure.retryAfterMs ?? 30_000 } : {}),
      });
      throw new GitHubReplyError(failure.code, retryable, failure.retryAfterMs ?? 30_000);
    }
    const id = messageId(response.body, credential.botUserId);
    if (id === undefined) {
      await this.deps.ledger.fail(request, { status: "ambiguous", code: "receipt_invalid" });
      throw new GitHubReplyError("receipt_invalid", true);
    }
    return this.deps.ledger.complete(request, id);
  }

  private async reconcile(
    request: GitHubReplyRequest,
    credential: GitHubReplyCredential,
    path: string,
    marker: string
  ): Promise<ChannelDeliveryRecord> {
    for (let page = 1; page <= 20; page += 1) {
      const response = await this.deps.http.send(
        { method: "GET", path, query: { per_page: "100", page: String(page) } },
        credential.token
      );
      const failure = classifyHttpFailure(response, false);
      if (failure !== null) {
        throw new GitHubReplyError(failure.code, true, failure.retryAfterMs ?? 30_000);
      }
      if (!Array.isArray(response.body)) throw new GitHubReplyError("receipt_invalid", true);
      for (const comment of response.body) {
        const id = messageId(comment, credential.botUserId);
        const body = object(comment)?.body;
        if (id !== undefined && typeof body === "string" && body.endsWith(`\n\n${marker}`)) {
          return this.deps.ledger.complete(request, id);
        }
      }
      const link = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "link");
      if (!link?.[1].includes('rel="next"') && response.body.length < 100) break;
    }
    // Comment creation has no idempotency guarantee; absence is not proof a timed-out write failed.
    throw new GitHubReplyError("uncertain_reply_requires_reconciliation", true, 60_000);
  }
}
