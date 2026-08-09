import { randomUUID } from "node:crypto";
import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  MemoryCandidateScreen,
  MemoryContradictionPort,
  MemoryDeps,
  MemoryExtractionPort,
  MemoryTelemetryPort,
  PendingMemory,
  ProposeCandidatesResult,
  ResolvePendingResult,
} from "@tulipfarm/memory";
import {
  MEMORY_METRICS,
  proposeMemoryCandidates,
  recordMemoryGauge,
  resolvePendingMemory,
} from "@tulipfarm/memory";
import type { Queryable } from "../db";
import { PgMemoryAssertionStore } from "./assertion-store";
import type { MemoryEmbedder } from "./embedder";
import type { PgMemoryEpisodeStore } from "./episode-store";
import { PgPendingMemoryStore } from "./pending-store";

/**
 * Adapts the turn's own prompt-injection guard into the candidate screen.
 *
 * Reusing the guard rather than writing a second detector is the point: a pattern that would be
 * blocked on the way *in* must also be blocked on the way into memory, and two implementations
 * would inevitably drift into a gap between them. A guardrails failure screens nothing out, which
 * is safe here only because the candidate is still inferred, still pending, and still shown to a
 * human before it can ever be recalled.
 */
export class GuardrailsCandidateScreen implements MemoryCandidateScreen {
  constructor(
    private readonly guardrails: GuardrailsService,
    private readonly userId: string
  ) {}

  async isInjection(text: string): Promise<boolean> {
    const result = await this.guardrails.runInput(text, {
      userId: this.userId,
      conversationId: "memory-extraction",
    });
    return result.blocked;
  }
}

/**
 * Settings for extraction-time proposals.
 *
 * Distinct from `KV_MEMORY_SETTINGS`, which disables inferred memory because the KV surface has no
 * confirmation UI. Here inference is the entire point, so it is enabled — and `confirmationRequired`
 * is `true` because there is no other value: an inferred statement that skipped confirmation would
 * make the pending table decorative.
 */
export const EXTRACTION_MEMORY_SETTINGS = {
  scopes: ["user_private"],
  inferredDurableMemory: { enabled: true, confirmationRequired: true },
} as const;

export interface ExtractionRequest {
  readonly userId: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly outcome?: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly evidence?: readonly { readonly kind: "message"; readonly ref: string }[];
}

/**
 * Mines a finished turn for durable facts and parks them for the user to confirm.
 *
 * Nothing this service extracts as an Assertion can write to the assertion store. Extraction
 * produces candidates, screening removes the ones that must never be proposed, and
 * `proposeMemoryCandidates` forces the rest through the inferred path — so the only way one
 * becomes a durable fact is a person confirming it. M5 Run Episodes are separate historical
 * summaries and are recorded best-effort through their own store.
 */
export class MemoryExtractionService {
  private readonly store: PgMemoryAssertionStore;
  private readonly pendingStore: PgPendingMemoryStore;

  constructor(
    q: Queryable,
    private readonly extractor: MemoryExtractionPort,
    private readonly guardrails?: GuardrailsService,
    embedder?: MemoryEmbedder,
    private readonly now: () => Date = () => new Date(),
    private readonly contradiction?: MemoryContradictionPort,
    private readonly episodes?: PgMemoryEpisodeStore,
    private readonly telemetry?: MemoryTelemetryPort
  ) {
    this.store = new PgMemoryAssertionStore(q, embedder);
    this.pendingStore = new PgPendingMemoryStore(q);
  }

  private deps(): MemoryDeps {
    return {
      store: this.store,
      pending: this.pendingStore,
      settings: EXTRACTION_MEMORY_SETTINGS,
      // Only reachable on confirmation: a candidate that is still pending has not been committed,
      // so nothing it might contradict is at risk while it waits.
      ...(this.contradiction === undefined ? {} : { contradiction: this.contradiction }),
      ...(this.telemetry === undefined ? {} : { telemetry: this.telemetry }),
      now: this.now,
      newId: () => randomUUID(),
    };
  }

  async extractFromTurn(request: ExtractionRequest): Promise<ProposeCandidatesResult> {
    const candidates = await this.extractor.extract({
      businessId: DEPLOYMENT_BUSINESS_ID,
      messages: request.messages,
    });
    await this.recordRunEpisode(request);
    if (candidates.length === 0) {
      await this.recordPendingQueue();
      return { proposed: [], rejected: [] };
    }

    const screen =
      this.guardrails === undefined
        ? undefined
        : new GuardrailsCandidateScreen(this.guardrails, request.userId);

    const result = await proposeMemoryCandidates(
      this.deps(),
      {
        target: {
          scope: "user_private",
          businessId: DEPLOYMENT_BUSINESS_ID,
          subjectPrincipalId: request.userId,
        },
        candidates,
        authorPrincipalId: request.userId,
        ...(request.agentId === undefined ? {} : { authorAgentId: request.agentId }),
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        ...(request.evidence === undefined ? {} : { evidence: request.evidence }),
      },
      { businessId: DEPLOYMENT_BUSINESS_ID, principalId: request.userId },
      screen
    );
    await this.recordPendingQueue();
    return result;
  }

  /** The candidates awaiting this user's decision. */
  listPending(userId: string): Promise<readonly PendingMemory[]> {
    return this.pendingStore.listForPrincipal(DEPLOYMENT_BUSINESS_ID, userId, this.now());
  }

  /**
   * Records a decision. The engine reauthorizes the deciding principal against the target scope,
   * so a confirmation answered by the wrong person confirms nothing and leaves the record intact
   * for its real owner.
   */
  async resolve(
    userId: string,
    pendingId: string,
    decision: "confirm" | "deny"
  ): Promise<ResolvePendingResult> {
    const result = await resolvePendingMemory(
      this.deps(),
      { businessId: DEPLOYMENT_BUSINESS_ID, pendingId, decision },
      { businessId: DEPLOYMENT_BUSINESS_ID, principalId: userId }
    );
    await this.recordPendingQueue();
    return result;
  }

  /** Drops everything past its confirmation window. Safe to call on any schedule, or none. */
  async purgeExpired(): Promise<number> {
    const purged = await this.pendingStore.purgeExpired(DEPLOYMENT_BUSINESS_ID, this.now());
    await this.recordPendingQueue();
    return purged;
  }

  private async recordRunEpisode(request: ExtractionRequest): Promise<void> {
    const episodes = this.episodes;
    if (episodes === undefined || request.runId === undefined) return;
    const summary = latestAssistantText(request.messages) ?? latestUserText(request.messages);
    if (summary === undefined || summary.trim().length === 0) return;
    try {
      await episodes.recordRunEpisode({
        principalId: request.userId,
        target: {
          scope: "user_private",
          businessId: DEPLOYMENT_BUSINESS_ID,
          subjectPrincipalId: request.userId,
        },
        runId: request.runId,
        summary,
        outcome: request.outcome ?? "succeeded",
        ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
        ...(request.evidence === undefined ? {} : { evidence: request.evidence }),
      });
    } catch {
      // A Run Episode improves future recall; losing it must not affect the already-completed Turn.
    }
  }

  private async recordPendingQueue(): Promise<void> {
    const telemetry = this.telemetry;
    if (telemetry === undefined) return;
    try {
      const stats = await this.pendingStore.queueStats(DEPLOYMENT_BUSINESS_ID, this.now());
      recordMemoryGauge(telemetry, MEMORY_METRICS.pendingDepth, stats.depth, {
        queue: "confirmation",
      });
      recordMemoryGauge(telemetry, MEMORY_METRICS.pendingOldestAgeMs, stats.oldestAgeMs, {
        queue: "confirmation",
      });
    } catch {
      // Queue telemetry is health signal only; it must not affect extraction or confirmation.
    }
  }
}

function latestAssistantText(
  messages: readonly { readonly role: string; readonly content: string }[]
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message !== undefined && message.role === "assistant") return message.content;
  }
  return undefined;
}

function latestUserText(
  messages: readonly { readonly role: string; readonly content: string }[]
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message !== undefined && message.role === "user") return message.content;
  }
  return undefined;
}
