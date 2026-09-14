import type { TaskAction, TaskAssigneeKind } from "@tulipfarm/storage";

/** Everything a check predicate needs to decide whether its gap is still open. */
export interface TaskCheckSignals {
  readonly hasProviderKey: boolean;
  readonly businessName?: string;
  /** False while the first-run wizard is still in flight, which owns some of these questions. */
  readonly setupComplete: boolean;
  /** Soul resource type keys (singular, e.g. `"ticket"`) that already exist. */
  readonly resources?: readonly string[];
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

/**
 * Mirrors the chat-chip catalog in `apps/api/src/onboarding/catalog.ts` (singular resource keys —
 * rename both or neither). The Worker cannot import an app, so the resource-setup entries this
 * reconciler needs are kept here instead.
 */
const RESOURCE_SETUP_CATALOG: ReadonlyArray<{
  readonly id: string;
  readonly resource: string;
  readonly title: string;
  readonly prompt: string;
}> = [
  {
    id: "tickets",
    resource: "ticket",
    title: "Set up ticket management",
    prompt: "Help me set up ticket management.",
  },
  {
    id: "leads",
    resource: "lead",
    title: "Track sales leads",
    prompt: "Help me track sales leads.",
  },
  {
    id: "employees",
    resource: "employee",
    title: "Manage employees",
    prompt: "Help me set up employee management.",
  },
  {
    id: "invoices",
    resource: "invoice",
    title: "Track invoices & billing",
    prompt: "Help me set up invoices and billing.",
  },
  {
    id: "inventory",
    resource: "inventory",
    title: "Manage inventory",
    prompt: "Help me set up inventory tracking.",
  },
  {
    id: "projects",
    resource: "project",
    title: "Organize projects & tasks",
    prompt: "Help me organize projects and tasks.",
  },
];

function resourceSetupChecks(resources: readonly string[]): TaskCheckResult[] {
  const existing = new Set(resources);
  return RESOURCE_SETUP_CATALOG.map((entry) => ({
    dedupeKey: `onboarding:${entry.id}`,
    ...ADMIN,
    title: entry.title,
    action: { kind: "chat", prompt: entry.prompt },
    blocking: false,
    satisfied: existing.has(entry.resource),
  }));
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
    ...resourceSetupChecks(signals.resources ?? []),
  ];
}
