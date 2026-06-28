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
