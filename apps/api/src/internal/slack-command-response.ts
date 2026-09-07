import { canonicalHash } from "@tulipfarm/schema";
import type { Queryable } from "../db";

export type SlackCommandResponseKind = "starting" | "unlinked" | "denied" | "prompt_unavailable";

type SlackCommandResponseStatus = "pending" | "leased" | "retry_wait" | "succeeded" | "failed";

export interface SlackCommandResponseJob {
  readonly businessId: string;
  readonly idempotencyKey: string;
  readonly responseUrlSecretKey: string;
  readonly responseUrlHash: string;
  readonly response: SlackCommandResponseKind;
  readonly status: SlackCommandResponseStatus;
  readonly attempts: number;
  readonly leaseOwner?: string;
}

interface SlackCommandResponseRow {
  business_id: string;
  idempotency_key: string;
  response_url_secret_key: string;
  response_url_hash: string;
  response_kind: SlackCommandResponseKind;
  status: SlackCommandResponseStatus;
  attempts: number;
  lease_owner: string | null;
}

const COLUMNS = `business_id, idempotency_key, response_url_secret_key, response_url_hash,
  response_kind, status, attempts, lease_owner`;
const QUALIFIED_COLUMNS = `jobs.business_id, jobs.idempotency_key,
  jobs.response_url_secret_key, jobs.response_url_hash, jobs.response_kind, jobs.status,
  jobs.attempts, jobs.lease_owner`;
const ACK_RECOVERY_GRACE_MS = 3_000;

function job(row: SlackCommandResponseRow): SlackCommandResponseJob {
  return {
    businessId: row.business_id,
    idempotencyKey: row.idempotency_key,
    responseUrlSecretKey: row.response_url_secret_key,
    responseUrlHash: row.response_url_hash,
    response: row.response_kind,
    status: row.status,
    attempts: row.attempts,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
  };
}

export class SlackCommandResponseStore {
  constructor(
    private readonly q: Queryable,
    private readonly now: () => Date = () => new Date()
  ) {}

  async find(
    businessId: string,
    idempotencyKey: string
  ): Promise<SlackCommandResponseJob | undefined> {
    const { rows } = await this.q.query<SlackCommandResponseRow>(
      `SELECT ${COLUMNS}
         FROM slack_command_response_jobs
        WHERE business_id = $1 AND idempotency_key = $2`,
      [businessId, idempotencyKey]
    );
    return rows[0] === undefined ? undefined : job(rows[0]);
  }

  async enqueue(input: {
    businessId: string;
    idempotencyKey: string;
    responseUrlSecretKey: string;
    responseUrlHash: string;
    response: SlackCommandResponseKind;
  }): Promise<"reserved" | "duplicate"> {
    const now = this.now();
    const inserted = await this.q.query(
      `INSERT INTO slack_command_response_jobs (
         business_id, idempotency_key, response_url_secret_key, response_url_hash, response_kind,
         status, attempts, next_attempt_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $7, $7)
       ON CONFLICT (business_id, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [
        input.businessId,
        input.idempotencyKey,
        input.responseUrlSecretKey,
        input.responseUrlHash,
        input.response,
        new Date(now.getTime() + ACK_RECOVERY_GRACE_MS),
        now,
      ]
    );
    if (inserted.rows.length === 1) return "reserved";

    const existing = await this.find(input.businessId, input.idempotencyKey);
    if (
      existing?.responseUrlHash !== input.responseUrlHash ||
      existing.response !== input.response
    ) {
      throw new Error("slack_command_response_conflict");
    }
    return "duplicate";
  }

  async claim(input: {
    businessId: string;
    owner: string;
    limit: number;
    leaseDurationMs: number;
    idempotencyKey?: string;
  }): Promise<readonly SlackCommandResponseJob[]> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
    const { rows } = await this.q.query<SlackCommandResponseRow>(
      `WITH candidates AS (
         SELECT business_id, idempotency_key
           FROM slack_command_response_jobs
          WHERE business_id = $1
            AND ($3::text IS NULL OR idempotency_key = $3)
            AND (
              (status = 'pending' AND ($3::text IS NOT NULL OR next_attempt_at <= $2))
              OR (status = 'retry_wait' AND next_attempt_at <= $2)
              OR (status = 'leased' AND lease_expires_at <= $2)
            )
          ORDER BY next_attempt_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $4
       )
       UPDATE slack_command_response_jobs AS jobs
          SET status = 'leased',
              attempts = attempts + 1,
              lease_owner = $5,
              lease_expires_at = $6,
              updated_at = $2
         FROM candidates
        WHERE jobs.business_id = candidates.business_id
          AND jobs.idempotency_key = candidates.idempotency_key
       RETURNING ${QUALIFIED_COLUMNS}`,
      [
        input.businessId,
        now,
        input.idempotencyKey ?? null,
        input.limit,
        input.owner,
        leaseExpiresAt,
      ]
    );
    return rows.map(job);
  }

  async complete(job: SlackCommandResponseJob): Promise<void> {
    await this.finish(job, "succeeded");
  }

  async fail(
    job: SlackCommandResponseJob,
    input: { retry: boolean; code: string; retryAfterMs?: number }
  ): Promise<void> {
    const now = this.now();
    const status = input.retry ? "retry_wait" : "failed";
    const nextAttemptAt = input.retry
      ? new Date(now.getTime() + (input.retryAfterMs ?? 1_000))
      : null;
    const result = await this.q.query(
      `UPDATE slack_command_response_jobs
          SET status = $4,
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_attempt_at = $5,
              last_error_code = $6,
              updated_at = $7
        WHERE business_id = $1
          AND idempotency_key = $2
          AND status = 'leased'
          AND lease_owner = $3
        RETURNING idempotency_key`,
      [job.businessId, job.idempotencyKey, job.leaseOwner, status, nextAttemptAt, input.code, now]
    );
    if (result.rows.length !== 1) throw new Error("slack_command_response_lease_lost");
  }

  private async finish(job: SlackCommandResponseJob, status: "succeeded"): Promise<void> {
    const result = await this.q.query(
      `UPDATE slack_command_response_jobs
          SET status = $4,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error_code = NULL,
              updated_at = $5
        WHERE business_id = $1
          AND idempotency_key = $2
          AND status = 'leased'
          AND lease_owner = $3
        RETURNING idempotency_key`,
      [job.businessId, job.idempotencyKey, job.leaseOwner, status, this.now()]
    );
    if (result.rows.length !== 1) throw new Error("slack_command_response_lease_lost");
  }
}

export interface SlackCommandResponseSecrets {
  set(key: string, value: string, type: "auto-generated"): Promise<void>;
  get(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

const RESPONSE_TEXT: Readonly<Record<SlackCommandResponseKind, string>> = {
  starting: "Starting your TulipFarm request…",
  unlinked: "Connect your Slack account to TulipFarm before starting a request.",
  denied: "I could not start that request here. Check your account link and channel access.",
  prompt_unavailable: "Add your request after `/tulipfarm`. Prompt modals are not available yet.",
};

function responseUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "hooks.slack.com" && url.hostname !== "hooks.slack-gov.com") ||
      !url.pathname.startsWith("/commands/") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export class SlackCommandResponseService {
  constructor(
    private readonly deps: {
      businessId: string;
      store: SlackCommandResponseStore;
      secrets: SlackCommandResponseSecrets;
      fetch?: typeof globalThis.fetch;
    }
  ) {}

  async reserve(input: {
    idempotencyKey: string;
    responseUrl: string;
    response: SlackCommandResponseKind;
  }): Promise<"reserved" | "duplicate"> {
    const url = responseUrl(input.responseUrl);
    if (url === undefined) throw new Error("slack_command_response_url_invalid");
    const responseUrlHash = canonicalHash(url.toString());
    const existing = await this.deps.store.find(this.deps.businessId, input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.responseUrlHash !== responseUrlHash || existing.response !== input.response) {
        throw new Error("slack_command_response_conflict");
      }
      return "duplicate";
    }

    const responseUrlSecretKey = `slack.command-response.${canonicalHash([
      input.idempotencyKey,
      responseUrlHash,
    ])}`;
    await this.deps.secrets.set(responseUrlSecretKey, url.toString(), "auto-generated");
    return this.deps.store.enqueue({
      businessId: this.deps.businessId,
      idempotencyKey: input.idempotencyKey,
      responseUrlSecretKey,
      responseUrlHash,
      response: input.response,
    });
  }

  async process(
    owner: string,
    idempotencyKey?: string
  ): Promise<{ attempted: number; delivered: number }> {
    const jobs = await this.deps.store.claim({
      businessId: this.deps.businessId,
      owner,
      limit: 10,
      leaseDurationMs: 30_000,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    let delivered = 0;
    for (const job of jobs) {
      if (await this.deliver(job)) delivered += 1;
    }
    return { attempted: jobs.length, delivered };
  }

  private async deliver(job: SlackCommandResponseJob): Promise<boolean> {
    try {
      const url = await this.deps.secrets.get(job.responseUrlSecretKey);
      const response = await (this.deps.fetch ?? globalThis.fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ response_type: "ephemeral", text: RESPONSE_TEXT[job.response] }),
      });
      if (response.ok) {
        await this.deps.store.complete(job);
        await this.deps.secrets.delete(job.responseUrlSecretKey);
        return true;
      }

      const retry = (response.status === 429 || response.status >= 500) && job.attempts < 3;
      const retryAfter = Number(response.headers.get("retry-after") ?? 1);
      await this.deps.store.fail(job, {
        retry,
        code: `http_${response.status}`,
        ...(retry
          ? { retryAfterMs: (Number.isFinite(retryAfter) ? Math.max(1, retryAfter) : 1) * 1_000 }
          : {}),
      });
      if (!retry) await this.deps.secrets.delete(job.responseUrlSecretKey);
      return false;
    } catch {
      const retry = job.attempts < 3;
      await this.deps.store.fail(job, { retry, code: "delivery_failed", retryAfterMs: 1_000 });
      if (!retry) await this.deps.secrets.delete(job.responseUrlSecretKey).catch(() => {});
      return false;
    }
  }
}
