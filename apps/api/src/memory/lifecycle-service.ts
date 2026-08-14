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
import { eraseMemory, forgetMemory, rememberProceduralCorrection } from "@tulipfarm/memory";
import type { Queryable } from "../db";
import { PgMemoryAssertionStore } from "./assertion-store";
import type { MemoryEmbedder } from "./embedder";
import { PgPendingMemoryStore } from "./pending-store";

export const USER_MEMORY_LIFECYCLE_SETTINGS: MemorySettingsView = {
  scopes: ["user_private"],
  inferredDurableMemory: { enabled: false },
};

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

  private deps(): MemoryDeps {
    return {
      store: this.store,
      pending: this.pending,
      settings: USER_MEMORY_LIFECYCLE_SETTINGS,
      ...(this.telemetry === undefined ? {} : { telemetry: this.telemetry }),
      now: this.now,
      newId: () => randomUUID(),
    };
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
