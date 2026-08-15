import { apiGet, apiWrite } from "./api";

/*
 * Read/mutate client for the Task system (docs/plans/task-system.md): system-created human
 * work items — never user-created, so there is no create call here. Backs the Companion panel
 * and the home "My Tasks" preview card; Tasks have no dedicated list page.
 */

export type TaskAction =
  | { kind: "answer"; field: string; sink: "business_profile" | "memory"; hint?: string }
  | { kind: "chat"; prompt: string }
  | { kind: "link"; href: string }
  | { kind: "ack" };

export type TaskStatus = "open" | "claimed" | "done" | "snoozed" | "dismissed";

export type Task = {
  id: string;
  title: string;
  detail?: string;
  action: TaskAction;
  blocking: boolean;
  status: TaskStatus;
  dueAt?: string;
  remindAt?: string;
  createdAt: string;
};

export async function listTasks(options?: { includeSnoozed?: boolean }): Promise<Task[]> {
  const qs = options?.includeSnoozed ? "?includeSnoozed=true" : "";
  const body = await apiGet<{ tasks: Task[] }>(`/api/v1/tasks${qs}`);
  return body.tasks;
}

export async function answerTask(id: string, value: string): Promise<void> {
  await apiWrite("POST", `/api/v1/tasks/${encodeURIComponent(id)}/answer`, { value });
}

export async function claimTask(id: string): Promise<void> {
  await apiWrite("POST", `/api/v1/tasks/${encodeURIComponent(id)}/claim`, {});
}

export async function completeTask(id: string): Promise<void> {
  await apiWrite("POST", `/api/v1/tasks/${encodeURIComponent(id)}/done`, {});
}

export async function snoozeTask(id: string, until: string): Promise<void> {
  await apiWrite("POST", `/api/v1/tasks/${encodeURIComponent(id)}/snooze`, { until });
}

export async function dismissTask(id: string): Promise<void> {
  await apiWrite("POST", `/api/v1/tasks/${encodeURIComponent(id)}/dismiss`, {});
}
