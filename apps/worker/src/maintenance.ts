/**
 * The maintenance-mode consumers, and everything they need built.
 *
 * Lives apart from `main.ts` only so that composition root stays readable: these queues are the
 * one part of the worker that runs on a clock rather than on a Run, and none of them exists at all
 * outside maintenance mode.
 */

import type { BuiltInAgentModelSource } from "@tulipfarm/built-in-agents";
import { MemoryDocumentRepo } from "@tulipfarm/memory";
import { PgBundleStore } from "@tulipfarm/soul";
import type { BlobPort, TransactionPort } from "@tulipfarm/storage";
import { PgMemoryCurationStore, TaskRepo } from "@tulipfarm/storage";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { buildWorkerFileService } from "./files/service";
import type { InternalApiClient } from "./internal/client";
import type { HttpTurnHost } from "./internal/turn-host";
import { startJobConsumers } from "./job-consumers";
import { buildWorkerKnowledgeService } from "./knowledge/service";
import { runMemoryCuration } from "./memory-curation/run";
import { TaskSignalsGatherer } from "./reconcile/task-signals";
import type { SoulEmbeddings } from "./tools/soul-embeddings";

export interface MaintenanceConsumerOptions {
  readonly databaseUrl: string;
  readonly pool: Pool;
  readonly transactions: TransactionPort;
  readonly businessId: string;
  readonly log: Parameters<typeof startJobConsumers>[0]["log"];
  readonly turnHost: HttpTurnHost;
  readonly internalApi: InternalApiClient;
  readonly blobs: BlobPort;
  readonly embeddings: SoulEmbeddings;
  readonly models: BuiltInAgentModelSource;
}

/** The Curator reports a per-run summary on `info`; the consumer options only promise `error`. */
function sweepLog(
  log: MaintenanceConsumerOptions["log"]
): { info(message: string): void; error(message: string): void } | undefined {
  if (log?.info === undefined) return undefined;
  const info = log.info.bind(log);
  return { info, error: (message) => log.error(message) };
}

export function startMaintenanceConsumers(o: MaintenanceConsumerOptions): Promise<PgBoss> {
  return startJobConsumers({
    databaseUrl: o.databaseUrl,
    database: o.pool,
    log: o.log,
    businessId: o.businessId,
    taskStore: new TaskRepo(o.transactions),
    taskSignals: new TaskSignalsGatherer(o.turnHost),
    memoryCuration: () =>
      runMemoryCuration({
        businessId: o.businessId,
        store: new PgMemoryCurationStore(o.pool),
        documents: new MemoryDocumentRepo(o.transactions),
        models: o.models,
        ...(sweepLog(o.log) === undefined ? {} : { log: sweepLog(o.log) }),
      }),
    bundles: new PgBundleStore(o.transactions),
    // Indexing a File parses a stranger's PDF, so it runs here rather than in the API. Both
    // services are the same ones the hosted Tools use, so an indexed passage and a passage read
    // in chat can never disagree about who may see it.
    fileIndex: {
      files: buildWorkerFileService({ db: o.pool, transactions: o.transactions, blobs: o.blobs }),
      knowledge: buildWorkerKnowledgeService({
        db: o.pool,
        transactions: o.transactions,
        embeddings: o.embeddings,
      }),
    },
  });
}
