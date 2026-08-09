/**
 * Episodic Memory (M5).
 *
 * Assertions say what is true; Episodes say what happened. The distinction matters because a
 * model-written summary is useful recall context but must not become a standing instruction or a
 * user-stated fact. Episodes therefore carry their own source and outcome, while the composing app
 * may project them into the M2 recall tier through chunks.
 */

import type { MemoryEvidenceRef } from "./memory";
import type { MemoryScopeDenialReason, MemoryScopeRequest, MemoryScopeTarget } from "./scope";
import { authorizeMemoryScope, type MemoryScopeDecision } from "./scope";
import { MEMORY_METRICS, type MemoryTelemetryPort, recordMemoryCounter } from "./telemetry";

export const MEMORY_EPISODE_SOURCE_TYPES = ["conversation", "run"] as const;
export type MemoryEpisodeSourceType = (typeof MEMORY_EPISODE_SOURCE_TYPES)[number];

export const MEMORY_EPISODE_CHUNK_TYPES = ["summary", "decision", "outcome"] as const;
export type MemoryEpisodeChunkType = (typeof MEMORY_EPISODE_CHUNK_TYPES)[number];

export interface MemoryEpisodeSource {
  readonly type: MemoryEpisodeSourceType;
  /** Conversation id or Run id, depending on `type`. */
  readonly id: string;
}

export interface MemoryEpisodeProvenance {
  readonly authorPrincipalId: string;
  readonly authorAgentId?: string;
  readonly runId?: string;
  readonly evidence: readonly MemoryEvidenceRef[];
}

export interface MemoryEpisode {
  readonly episodeId: string;
  readonly businessId: string;
  readonly target: MemoryScopeTarget;
  readonly source: MemoryEpisodeSource;
  /** The episodic Assertion projection used by the existing recall tier. */
  readonly assertionId: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly outcome: string;
  readonly provenance: MemoryEpisodeProvenance;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryEpisodeChunk {
  readonly chunkId: string;
  readonly businessId: string;
  readonly episodeId: string;
  readonly assertionId: string;
  readonly target: MemoryScopeTarget;
  readonly chunkType: MemoryEpisodeChunkType;
  readonly position: number;
  readonly text: string;
  readonly createdAt: string;
}

export type MemoryEpisodeWriteResult =
  | { readonly outcome: "saved"; readonly episode: MemoryEpisode }
  | { readonly outcome: "denied"; readonly reason: MemoryScopeDenialReason };

export interface MemoryEpisodeStore {
  put(episode: MemoryEpisode, scopeRequest: MemoryScopeRequest): Promise<MemoryEpisodeWriteResult>;
  get(businessId: string, episodeId: string): Promise<MemoryEpisode | undefined>;
}

/**
 * Episodes use the same owner check as Assertions. This helper keeps store implementations from
 * inventing a second authorization path just because the rows live in a second table.
 */
export function authorizeMemoryEpisode(
  enabledScopes: readonly MemoryScopeTarget["scope"][],
  episode: Pick<MemoryEpisode, "target"> & { readonly source?: Pick<MemoryEpisodeSource, "type"> },
  request: MemoryScopeRequest,
  telemetry?: MemoryTelemetryPort
): MemoryScopeDecision {
  const decision = authorizeMemoryScope(enabledScopes, episode.target, request);
  recordMemoryCounter(telemetry, MEMORY_METRICS.episodeAccess, 1, {
    outcome: decision.allowed ? "allowed" : "denied",
    scope: episode.target.scope,
    source_type: episode.source?.type ?? "unknown",
    ...(decision.allowed ? {} : { reason: decision.reason }),
  });
  return decision;
}
