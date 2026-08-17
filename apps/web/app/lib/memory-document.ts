import { apiGet } from "./api";

export interface MemoryDocument {
  readonly document: string;
  readonly characters: number;
  readonly characterBudget: number;
  readonly updatedAt?: string;
}

/**
 * Read-only by design. There is no writing counterpart and there should not be one: Memory is
 * what the system concluded, corrected by saying so in chat, not by editing the page.
 */
export function getMemoryDocument(): Promise<MemoryDocument> {
  return apiGet<MemoryDocument>("/api/v1/memory/document");
}
