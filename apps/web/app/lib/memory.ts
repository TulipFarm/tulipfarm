import { apiDelete, apiGet, apiWrite } from "./api";

export type MemoryEntry = {
  key: string;
  value: string;
  writtenByAgentId: string | null;
  createdAt: string;
  lastWrittenAt: string;
};

export type MemoryData = { entries: MemoryEntry[]; maxValueChars: number };

// The assistant's saved facts about the current user (the `<memory>` block). Read + edit-value
// + delete only — keys and creation belong to the assistant.
export async function listMemory(): Promise<MemoryData> {
  return apiGet<MemoryData>("/api/v1/memory");
}

export async function updateMemoryEntry(key: string, value: string): Promise<MemoryEntry> {
  return apiWrite<MemoryEntry>("PUT", `/api/v1/memory/${encodeURIComponent(key)}`, { value });
}

export async function deleteMemoryEntry(key: string): Promise<void> {
  return apiDelete(`/api/v1/memory/${encodeURIComponent(key)}`);
}

/** One memory the assistant inferred, waiting for the user to accept or reject it. */
export type PendingMemory = {
  pendingId: string;
  subject: string;
  statement: string;
  memoryType: string;
  confidence?: number;
  requestedAt: string;
  expiresAt: string;
};

/**
 * The confirmation queue. Inferred memories are *not* in `listMemory` — nothing the assistant
 * inferred is remembered until it is confirmed here, so these are two genuinely different lists.
 *
 * Absent on a deployment with extraction disabled, where the route is not registered at all; the
 * caller treats a 404 as an empty queue rather than an error.
 */
export async function listPendingMemory(): Promise<PendingMemory[]> {
  const data = await apiGet<{ pending: PendingMemory[] }>("/api/v1/memory/pending");
  return data.pending;
}

export async function resolvePendingMemory(
  pendingId: string,
  decision: "confirm" | "deny"
): Promise<void> {
  await apiWrite("POST", `/api/v1/memory/pending/${encodeURIComponent(pendingId)}`, { decision });
}
