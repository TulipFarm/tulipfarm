import { MemoryDocumentRepo } from "@tulipfarm/memory";
import type { Pool } from "pg";
import { transactionPort } from "../db";
import { MemoryErasureService } from "./erasure";

export interface MemoryCompositionDeps {
  pool: Pool;
}

export interface MemoryComposition {
  /** The user's memory: one Markdown page, written by Tools and the Curator, read every turn. */
  documents: MemoryDocumentRepo;
  erasure: MemoryErasureService;
}

/**
 * Memory in one place, so its wiring is a change to this file rather than surgery in the
 * composition root.
 */
export function buildMemoryServices(deps: MemoryCompositionDeps): MemoryComposition {
  const transactions = transactionPort(deps.pool);
  return {
    documents: new MemoryDocumentRepo(transactions),
    erasure: new MemoryErasureService(transactions),
  };
}
