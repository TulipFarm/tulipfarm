import { AdapterDispatchError, type ToolIntent } from "@tulipfarm/tool-broker";
import type { IntegrationHttpPort, IntegrationHttpResponse } from "../../http";

/**
 * Hidden marker written into a comment body so a repeated delivery — or a reconciliation after an
 * ambiguous write — can recognize the effect that already landed. Invisible in rendered Markdown.
 */
export function githubEffectMarker(idempotencyKey: string): string {
  return `<!-- tulipfarm-effect:${idempotencyKey} -->`;
}

export type Arguments = Record<string, unknown>;

/**
 * Provider access handed to the per-family operations. `call` classifies HTTP failures into
 * `AdapterDispatchError`; `http` is the unclassified port, needed only where a 404 is an expected
 * answer rather than a failure.
 */
export interface GitHubApi {
  readonly call: (
    request: Parameters<IntegrationHttpPort["send"]>[0],
    credential: string,
    mutating: boolean
  ) => Promise<IntegrationHttpResponse>;
  readonly http: IntegrationHttpPort;
}

export function args(intent: ToolIntent): Arguments {
  const value = intent.arguments;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value as Arguments;
}

export function stringArg(source: Arguments, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value;
}

/** Unlike `stringArg`, an absent or empty value is a legal "match everything" search. */
export function optionalStringArg(source: Arguments, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

export function numberArg(source: Arguments, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value;
}

export function stringListArg(source: Arguments, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value as string[];
}

export interface PushFile {
  readonly path: string;
  readonly content: string;
}

export function filesArg(source: Arguments, key: string): PushFile[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    const { path, content } = entry as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0 || typeof content !== "string") {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    return { path, content };
  });
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterDispatchError("after_dispatch", "provider_response_malformed", false);
  }
  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new AdapterDispatchError("after_dispatch", "provider_response_malformed", false);
  }
  return value;
}

export function names(value: unknown): string[] {
  return list(value).map((entry) => String(record(entry).name));
}

export function logins(value: unknown): string[] {
  return list(value).map((entry) => String(record(entry).login));
}

/** Repository slug from a search result's `repository_url`. */
export function repositoryFromUrl(url: unknown): string {
  const parts = String(url).split("/");
  return parts.slice(-2).join("/");
}

/** Shared shape of `/search/issues`, which backs both the issue and pull request searches. */
export function searchOutput(body: Record<string, unknown>): unknown {
  return {
    totalCount: Number(body.total_count),
    items: list(body.items).map((entry) => {
      const item = record(entry);
      return {
        repository: repositoryFromUrl(item.repository_url),
        number: Number(item.number),
        title: String(item.title),
        state: String(item.state),
        htmlUrl: String(item.html_url),
      };
    }),
  };
}
