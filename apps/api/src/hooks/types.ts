export type HookType = "before" | "after";

export interface WorkerRequest {
  id: number;
  hookType: HookType;
  hookSource: string;
  resourceType: string;
  record: Record<string, unknown>;
}

export type WorkerResponse =
  | { id: number; ok: true; record: Record<string, unknown> }
  | { id: number; ok: false; error: string; timedOut?: boolean };
