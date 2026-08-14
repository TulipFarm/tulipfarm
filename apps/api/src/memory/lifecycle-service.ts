import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type {
  EraseResult,
  ForgetResult,
  MemoryDeps,
  MemorySettingsView,
  MemoryTelemetryPort,
  RememberResult,
} from "@tulipfarm/memory";
import {
  eraseMemory,
  forgetMemory,
  rememberMemory,
  rememberProceduralCorrection,
} from "@tulipfarm/memory";
import type { Queryable } from "../db";
import { PgMemoryAssertionStore } from "./assertion-store";
import type { MemoryEmbedder } from "./embedder";
import { PgPendingMemoryStore } from "./pending-store";

export const USER_MEMORY_LIFECYCLE_SETTINGS: MemorySettingsView = {
  scopes: ["user_private"],
  inferredDurableMemory: { enabled: false },
};

/** Onboarding quest answers land as `user_private` or `business` facts, both human-stated. */
export const ONBOARDING_MEMORY_LIFECYCLE_SETTINGS: MemorySettingsView = {
  scopes: ["user_private", "business"],
  inferredDurableMemory: { enabled: false },
};

export interface FactInput {
  readonly authorPrincipalId: string;
  readonly target: { readonly scope: "business" } | { readonly scope: "user_private" };
  readonly subject: string;
  readonly statement: string;
}

export interface ProceduralCorrectionInput {
  readonly userId: string;
  readonly subject: string;
  readonly statement: string;
  readonly agentId?: string;
  readonly runId?: string;
}

/** Memory lifecycle composition; auth/audit shape lives in the package. */
export class MemoryLifecycleService {
  private readonly store: PgMemoryAssertionStore;
  private readonly pending: PgPendingMemoryStore;

  constructor(
    q: Queryable,
    private readonly now: () => Date = () => new Date(),
    embedder?: MemoryEmbedder,
    private readonly telemetry?: MemoryTelemetryPort
  ) {
    this.store = new PgMemoryAssertionStore(q, embedder);
    this.pending = new PgPendingMemoryStore(q);
  }

  private deps(settings: MemorySettingsView = USER_MEMORY_LIFECYCLE_SETTINGS): MemoryDeps {
    return {
      store: this.store,
      pending: this.pending,
      settings,
      ...(this.telemetry === undefined ? {} : { telemetry: this.telemetry }),
      now: this.now,
      newId: () => randomUUID(),
    };
  }

  /** Records a human-stated fact — an onboarding quest answer, not an LLM inference. */
  rememberFact(input: FactInput): Promise<RememberResult> {
    return rememberMemory(
      this.deps(ONBOARDING_MEMORY_LIFECYCLE_SETTINGS),
      {
        target: {
          scope: input.target.scope,
          businessId: DEPLOYMENT_BUSINESS_ID,
          ...(input.target.scope === "user_private"
            ? { subjectPrincipalId: input.authorPrincipalId }
            : {}),
        },
        subject: input.subject,
        statement: input.statement,
        confidence: 1,
        importance: 0.6,
        memoryType: "fact",
        trustTier: "user_stated",
        provenance: {
          origin: "explicit",
          authorPrincipalId: input.authorPrincipalId,
          evidence: [],
        },
        entities: [],
      },
      { businessId: DEPLOYMENT_BUSINESS_ID, principalId: input.authorPrincipalId }
    );
  }

  rememberCorrection(input: ProceduralCorrectionInput): Promise<RememberResult> {
    return rememberProceduralCorrection(
      this.deps(),
      {
        target: {
          scope: "user_private",
          businessId: DEPLOYMENT_BUSINESS_ID,
          subjectPrincipalId: input.userId,
        },
        subject: input.subject,
        statement: input.statement,
        authorPrincipalId: input.userId,
        ...(input.agentId === undefined ? {} : { authorAgentId: input.agentId }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
      },
      { businessId: DEPLOYMENT_BUSINESS_ID, principalId: input.userId }
    );
  }

  forget(userId: string, assertionId: string): Promise<ForgetResult> {
    return forgetMemory(
      this.deps(),
      { businessId: DEPLOYMENT_BUSINESS_ID, assertionId },
      { businessId: DEPLOYMENT_BUSINESS_ID, principalId: userId }
    );
  }

  erase(userId: string, assertionId: string): Promise<EraseResult> {
    return eraseMemory(
      this.deps(),
      { businessId: DEPLOYMENT_BUSINESS_ID, assertionId },
      { businessId: DEPLOYMENT_BUSINESS_ID, principalId: userId }
    );
  }
}
