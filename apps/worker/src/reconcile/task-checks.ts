import type { TaskAction, TaskAssigneeKind } from "@tulipfarm/storage";

/** Everything a check predicate needs to decide whether its gap is still open. */
export interface TaskCheckSignals {
  readonly hasProviderKey: boolean;
  readonly businessName?: string;
}

export interface TaskCheckResult {
  readonly dedupeKey: string;
  readonly assigneeKind: TaskAssigneeKind;
  readonly assigneeId: string;
  readonly title: string;
  readonly detail?: string;
  readonly action: TaskAction;
  readonly blocking: boolean;
  readonly satisfied: boolean;
}

const ADMIN = { assigneeKind: "role" as const, assigneeId: "admin" };

export function evaluateTaskChecks(signals: TaskCheckSignals): TaskCheckResult[] {
  return [
    {
      dedupeKey: "provider-key",
      ...ADMIN,
      title: "Connect a model provider",
      detail: "Agents need one provider connected before they can do anything.",
      action: { kind: "link", href: "/business/models" },
      blocking: true,
      satisfied: signals.hasProviderKey,
    },
    {
      dedupeKey: "business-name",
      ...ADMIN,
      title: "What's your business called?",
      action: { kind: "answer", field: "businessName", sink: "business_profile" },
      blocking: true,
      satisfied: signals.businessName !== undefined,
    },
  ];
}
