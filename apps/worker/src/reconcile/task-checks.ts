import type { TaskAction, TaskAssigneeKind } from "@tulipfarm/storage";

/** Everything a check predicate needs to decide whether its gap is still open. */
export interface TaskCheckSignals {
  readonly hasProviderKey: boolean;
  readonly businessName?: string;
  /** False while the first-run wizard is still in flight, which owns some of these questions. */
  readonly setupComplete: boolean;
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

/** The wizard writes `""` for fields the user left blank, so presence alone does not mean answered. */
function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

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
      // The wizard asks this itself, so opening a Task for it mid-setup races the answer: the user
      // finishes setup and lands on a list demanding what they just typed. Only a run that ended
      // without a name — a headless bootstrap with no BUSINESS_NAME — leaves a real gap here.
      satisfied: !signals.setupComplete || nonEmpty(signals.businessName),
    },
  ];
}
