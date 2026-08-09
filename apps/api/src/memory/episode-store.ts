import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  authorizeMemoryEpisode,
  endMemorySpan,
  MEMORY_METRICS,
  MEMORY_SPANS,
  type MemoryEpisode,
  type MemoryEpisodeChunkType,
  type MemoryEpisodeStore,
  type MemoryEpisodeWriteResult,
  type MemoryEvidenceRef,
  type MemoryScopeRequest,
  type MemoryScopeTarget,
  type MemorySettingsView,
  type MemoryTelemetryPort,
  recordMemoryCounter,
  recordMemorySpanError,
  setMemorySpanAttributes,
  startMemorySpan,
} from "@tulipfarm/memory";
import type { MemoryScope } from "@tulipfarm/schema";
import type { Queryable } from "../db";
import { PgMemoryAssertionStore } from "./assertion-store";
import { embeddableText, embedOne, type MemoryEmbedder } from "./embedder";

export const EPISODE_MEMORY_SETTINGS: MemorySettingsView = {
  scopes: ["user_private", "user_agent", "business"],
  inferredDurableMemory: { enabled: false },
};

const MAX_SUMMARY_CHARS = 4_000;
const MAX_DECISION_CHARS = 500;
const MAX_OUTCOME_CHARS = 1_000;
const MAX_DECISIONS = 20;

interface EpisodeRow {
  business_id: string;
  episode_id: string;
  assertion_id: string;
  scope: string;
  subject_principal_id: string | null;
  agent_id: string | null;
  role_id: string | null;
  run_id: string | null;
  source_type: "conversation" | "run";
  source_id: string;
  summary: string;
  decisions: string[] | null;
  outcome: string;
  author_principal_id: string;
  author_agent_id: string | null;
  provenance_run_id: string | null;
  evidence: unknown;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RecordConversationEpisodeInput {
  readonly principalId: string;
  readonly target: MemoryScopeTarget;
  readonly conversationId: string;
  readonly summary: string;
  readonly decisions?: readonly string[];
  readonly outcome?: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly evidence?: readonly MemoryEvidenceRef[];
}

export interface RecordRunEpisodeInput {
  readonly principalId: string;
  readonly target: MemoryScopeTarget;
  readonly runId: string;
  readonly summary: string;
  readonly decisions?: readonly string[];
  readonly outcome: string;
  readonly agentId?: string;
  readonly evidence?: readonly MemoryEvidenceRef[];
}

function cleanText(value: string, maxChars: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function cleanDecisions(decisions: readonly string[]): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const decision of decisions) {
    const text = cleanText(decision, MAX_DECISION_CHARS);
    const key = text.toLowerCase();
    if (text.length === 0 || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(text);
    if (cleaned.length === MAX_DECISIONS) break;
  }
  return cleaned;
}

/**
 * Pull decision bullets out of a summary we already paid to create.
 *
 * This is intentionally conservative: an unlabelled sentence can stay in the summary chunk and be
 * recalled there. Promoting every sentence to a decision would overstate what the user chose.
 */
export function decisionsFromEpisodeText(text: string): readonly string[] {
  const decisions: string[] = [];
  for (const line of text.split(/\r?\n|[•]/)) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    const match = /^(?:decision|decided|we decided|outcome decision)\s*:?\s*(.+)$/i.exec(trimmed);
    if (match?.[1] !== undefined) decisions.push(match[1]);
  }
  return cleanDecisions(decisions);
}

function targetFromRow(row: EpisodeRow): MemoryScopeTarget {
  return {
    scope: row.scope as MemoryScope,
    businessId: row.business_id,
    ...(row.subject_principal_id === null ? {} : { subjectPrincipalId: row.subject_principal_id }),
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(row.role_id === null ? {} : { roleId: row.role_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
  };
}

function evidenceFromRow(row: EpisodeRow): readonly MemoryEvidenceRef[] {
  return Array.isArray(row.evidence)
    ? row.evidence.filter((item): item is MemoryEvidenceRef => {
        if (typeof item !== "object" || item === null) return false;
        const ref = item as { kind?: unknown; ref?: unknown };
        return (
          (ref.kind === "message" ||
            ref.kind === "knowledge_source" ||
            ref.kind === "tool_result") &&
          typeof ref.ref === "string"
        );
      })
    : [];
}

function rowToEpisode(row: EpisodeRow): MemoryEpisode {
  return {
    episodeId: row.episode_id,
    businessId: row.business_id,
    assertionId: row.assertion_id,
    target: targetFromRow(row),
    source: { type: row.source_type, id: row.source_id },
    summary: row.summary,
    decisions: row.decisions ?? [],
    outcome: row.outcome,
    provenance: {
      authorPrincipalId: row.author_principal_id,
      ...(row.author_agent_id === null ? {} : { authorAgentId: row.author_agent_id }),
      ...(row.provenance_run_id === null ? {} : { runId: row.provenance_run_id }),
      evidence: evidenceFromRow(row),
    },
    ...(row.started_at === null ? {} : { startedAt: row.started_at.toISOString() }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at.toISOString() }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function episodeStatement(episode: MemoryEpisode): string {
  const parts = [`Summary: ${episode.summary}`];
  for (const decision of episode.decisions) parts.push(`Decision: ${decision}`);
  if (episode.outcome.length > 0) parts.push(`Outcome: ${episode.outcome}`);
  return parts.join("\n");
}

function chunkTexts(episode: MemoryEpisode): readonly {
  readonly chunkType: MemoryEpisodeChunkType;
  readonly text: string;
}[] {
  const chunks: { chunkType: MemoryEpisodeChunkType; text: string }[] = [
    { chunkType: "summary", text: episode.summary },
  ];
  for (const decision of episode.decisions) {
    chunks.push({ chunkType: "decision", text: decision });
  }
  if (episode.outcome.length > 0) chunks.push({ chunkType: "outcome", text: episode.outcome });
  return chunks.filter((chunk) => chunk.text.length > 0);
}

/**
 * Postgres implementation for Episodes and their retrieval chunks.
 *
 * The Assertion projection is written first because recall still materializes
 * `MemoryAssertion`s. Chunks then point at that id, so a chunk hit enters the same authorization
 * and ranking path as every other M2 memory candidate.
 */
export class PgMemoryEpisodeStore implements MemoryEpisodeStore {
  private readonly assertions: PgMemoryAssertionStore;

  constructor(
    private readonly db: Queryable,
    private readonly embedder?: MemoryEmbedder,
    private readonly now: () => Date = () => new Date(),
    private readonly telemetry?: MemoryTelemetryPort
  ) {
    this.assertions = new PgMemoryAssertionStore(db, embedder);
  }

  async put(
    episode: MemoryEpisode,
    scopeRequest: MemoryScopeRequest
  ): Promise<MemoryEpisodeWriteResult> {
    const span = startMemorySpan(this.telemetry, MEMORY_SPANS.episodeWrite, {
      source_type: episode.source.type,
      scope: episode.target.scope,
    });
    const access = authorizeMemoryEpisode(
      EPISODE_MEMORY_SETTINGS.scopes,
      episode,
      scopeRequest,
      this.telemetry
    );
    if (!access.allowed) {
      recordMemoryCounter(this.telemetry, MEMORY_METRICS.episodeWrites, 1, {
        outcome: "denied",
        reason: access.reason,
        source_type: episode.source.type,
        scope: episode.target.scope,
      });
      setMemorySpanAttributes(span, {
        outcome: "denied",
        reason: access.reason,
        source_type: episode.source.type,
        scope: episode.target.scope,
      });
      endMemorySpan(span);
      return { outcome: "denied", reason: access.reason };
    }

    const cleanEpisode = this.cleanEpisode(episode);
    try {
      await this.assertions.put({
        assertionId: cleanEpisode.assertionId,
        businessId: cleanEpisode.businessId,
        target: cleanEpisode.target,
        subject: `Episode: ${cleanEpisode.source.type} ${cleanEpisode.source.id}`,
        statement: episodeStatement(cleanEpisode),
        memoryType: "episodic",
        trustTier: "agent_inferred",
        confidence: 1,
        importance: 0.7,
        provenance: {
          origin: "inferred",
          authorPrincipalId: cleanEpisode.provenance.authorPrincipalId,
          ...(cleanEpisode.provenance.authorAgentId === undefined
            ? {}
            : { authorAgentId: cleanEpisode.provenance.authorAgentId }),
          ...(cleanEpisode.provenance.runId === undefined
            ? {}
            : { runId: cleanEpisode.provenance.runId }),
          evidence: cleanEpisode.provenance.evidence,
        },
        confirmation: "confirmed",
        status: "active",
        version: 1,
        createdAt: cleanEpisode.createdAt,
        updatedAt: cleanEpisode.updatedAt,
        validFrom: cleanEpisode.endedAt ?? cleanEpisode.createdAt,
        entities: cleanEpisode.decisions,
        accessCount: 0,
      });
      await this.upsertEpisode(cleanEpisode);
      const chunkCounts = await this.replaceChunks(cleanEpisode);
      recordMemoryCounter(this.telemetry, MEMORY_METRICS.episodeWrites, 1, {
        outcome: "saved",
        source_type: cleanEpisode.source.type,
        scope: cleanEpisode.target.scope,
      });
      for (const [chunkType, count] of Object.entries(chunkCounts)) {
        recordMemoryCounter(this.telemetry, MEMORY_METRICS.episodeChunks, count, {
          outcome: "indexed",
          source_type: cleanEpisode.source.type,
          chunk_type: chunkType,
        });
      }
      setMemorySpanAttributes(span, {
        outcome: "saved",
        source_type: cleanEpisode.source.type,
        scope: cleanEpisode.target.scope,
        chunks: Object.values(chunkCounts).reduce((sum, count) => sum + count, 0),
      });
      return { outcome: "saved", episode: cleanEpisode };
    } catch (error) {
      recordMemoryCounter(this.telemetry, MEMORY_METRICS.episodeWrites, 1, {
        outcome: "error",
        source_type: cleanEpisode.source.type,
        scope: cleanEpisode.target.scope,
      });
      recordMemorySpanError(span, "episode_write_failed");
      throw error;
    } finally {
      endMemorySpan(span);
    }
  }

  async get(businessId: string, episodeId: string): Promise<MemoryEpisode | undefined> {
    const { rows } = await this.db.query(
      `SELECT * FROM memory_episodes WHERE business_id = $1 AND episode_id = $2`,
      [businessId, episodeId]
    );
    const row = rows[0] as unknown as EpisodeRow | undefined;
    return row === undefined ? undefined : rowToEpisode(row);
  }

  async recordConversationEpisode(input: RecordConversationEpisodeInput): Promise<void> {
    const nowIso = this.now().toISOString();
    const episode = this.cleanEpisode({
      episodeId: `conversation:${input.conversationId}`,
      assertionId: `episode-assertion:conversation:${input.conversationId}`,
      businessId: DEPLOYMENT_BUSINESS_ID,
      target: input.target,
      source: { type: "conversation", id: input.conversationId },
      summary: input.summary,
      decisions: input.decisions ?? decisionsFromEpisodeText(input.summary),
      outcome: input.outcome ?? "",
      provenance: {
        authorPrincipalId: input.principalId,
        ...(input.agentId === undefined ? {} : { authorAgentId: input.agentId }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        evidence: input.evidence ?? [],
      },
      createdAt: nowIso,
      updatedAt: nowIso,
      endedAt: nowIso,
    });
    await this.put(episode, {
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: input.principalId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    });
  }

  async recordRunEpisode(input: RecordRunEpisodeInput): Promise<void> {
    const nowIso = this.now().toISOString();
    const episode = this.cleanEpisode({
      episodeId: `run:${input.runId}`,
      assertionId: `episode-assertion:run:${input.runId}`,
      businessId: DEPLOYMENT_BUSINESS_ID,
      target: input.target,
      source: { type: "run", id: input.runId },
      summary: input.summary,
      decisions: input.decisions ?? decisionsFromEpisodeText(input.summary),
      outcome: input.outcome,
      provenance: {
        authorPrincipalId: input.principalId,
        ...(input.agentId === undefined ? {} : { authorAgentId: input.agentId }),
        runId: input.runId,
        evidence: input.evidence ?? [],
      },
      createdAt: nowIso,
      updatedAt: nowIso,
      endedAt: nowIso,
    });
    await this.put(episode, {
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: input.principalId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      runId: input.runId,
    });
  }

  private cleanEpisode(episode: MemoryEpisode): MemoryEpisode {
    return {
      ...episode,
      summary: cleanText(episode.summary, MAX_SUMMARY_CHARS),
      decisions: cleanDecisions(episode.decisions),
      outcome: cleanText(episode.outcome, MAX_OUTCOME_CHARS),
      provenance: {
        ...episode.provenance,
        evidence: episode.provenance.evidence.filter(
          (item) => item.ref.trim().length > 0 && item.ref.length <= 500
        ),
      },
    };
  }

  private async upsertEpisode(episode: MemoryEpisode): Promise<void> {
    const target = episode.target;
    await this.db.query(
      `INSERT INTO memory_episodes (
         business_id, episode_id, assertion_id, scope, subject_principal_id, agent_id, role_id,
         run_id, source_type, source_id, summary, decisions, outcome, author_principal_id,
         author_agent_id, provenance_run_id, evidence, started_at, ended_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21)
       ON CONFLICT (business_id, episode_id) DO UPDATE SET
         summary = EXCLUDED.summary,
         decisions = EXCLUDED.decisions,
         outcome = EXCLUDED.outcome,
         author_principal_id = EXCLUDED.author_principal_id,
         author_agent_id = EXCLUDED.author_agent_id,
         provenance_run_id = EXCLUDED.provenance_run_id,
         evidence = EXCLUDED.evidence,
         started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at,
         updated_at = EXCLUDED.updated_at`,
      [
        episode.businessId,
        episode.episodeId,
        episode.assertionId,
        target.scope,
        target.subjectPrincipalId ?? null,
        target.agentId ?? null,
        target.roleId ?? null,
        target.runId ?? null,
        episode.source.type,
        episode.source.id,
        episode.summary,
        [...episode.decisions],
        episode.outcome,
        episode.provenance.authorPrincipalId,
        episode.provenance.authorAgentId ?? null,
        episode.provenance.runId ?? null,
        JSON.stringify(episode.provenance.evidence),
        episode.startedAt ?? null,
        episode.endedAt ?? null,
        episode.createdAt,
        episode.updatedAt,
      ]
    );
  }

  private async replaceChunks(
    episode: MemoryEpisode
  ): Promise<Record<MemoryEpisodeChunkType, number>> {
    await this.db.query("DELETE FROM memory_chunks WHERE business_id = $1 AND episode_id = $2", [
      episode.businessId,
      episode.episodeId,
    ]);
    const chunks = chunkTexts(episode);
    const counts: Record<MemoryEpisodeChunkType, number> = {
      summary: 0,
      decision: 0,
      outcome: 0,
    };
    for (const [position, chunk] of chunks.entries()) {
      const chunkId = `${episode.episodeId}:${position}`;
      const embedded = await this.embedChunk(chunk.text);
      const target = episode.target;
      await this.db.query(
        `INSERT INTO memory_chunks (
           business_id, chunk_id, episode_id, assertion_id, scope, subject_principal_id, agent_id,
           role_id, run_id, chunk_type, position, text, embedding, embedding_model,
           embedding_dim, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector,$14,$15,$16)`,
        [
          episode.businessId,
          chunkId,
          episode.episodeId,
          episode.assertionId,
          target.scope,
          target.subjectPrincipalId ?? null,
          target.agentId ?? null,
          target.roleId ?? null,
          target.runId ?? null,
          chunk.chunkType,
          position,
          chunk.text,
          embedded === undefined ? null : JSON.stringify(embedded.embedding),
          embedded?.model ?? null,
          embedded?.dimension ?? null,
          episode.createdAt,
        ]
      );
      counts[chunk.chunkType] += 1;
    }
    return counts;
  }

  private async embedChunk(
    text: string
  ): Promise<{ embedding: number[]; dimension: number; model: string | null } | undefined> {
    if (this.embedder === undefined || !this.embedder.isAvailable()) return undefined;
    try {
      const active = this.embedder.getActive();
      const embedded = await embedOne(this.embedder, embeddableText("episode", text));
      if (embedded === undefined) return undefined;
      return {
        ...embedded,
        model: active === null ? null : `${active.provider}:${active.model}`,
      };
    } catch {
      return undefined;
    }
  }
}
