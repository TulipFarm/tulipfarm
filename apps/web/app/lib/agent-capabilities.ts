import type {
  AgentCapabilityRestrictions,
  AgentRecordAction,
  AgentResourceTypeAction,
  AgentSummary,
  AllowDeny,
} from "./agents";

/*
 * Reads an Agent's authored capability restrictions the way a person asks about them: can it change
 * anything, what can it reach, what was it refused. The runtime enforces the restrictions; this only
 * describes them, so every helper here is pure and total — an agent with no restrictions block is a
 * real, answerable state ("unrestricted"), not a gap to render as empty.
 */

/** Record actions that write. Anything outside this set only reads. */
const WRITING_RECORD_ACTIONS: readonly AgentRecordAction[] = ["create", "update", "delete"];

/**
 * Resource-type actions that write. Creating or updating a resource *type* rewrites the schema
 * every Record of that type is validated against, so it is a heavier power than changing a Record
 * and must never be mistaken for reading.
 */
const WRITING_RESOURCE_TYPE_ACTIONS: readonly AgentResourceTypeAction[] = ["create", "update"];

export const RECORD_ACTION_ORDER: readonly AgentRecordAction[] = [
  "list",
  "search",
  "read",
  "create",
  "update",
  "delete",
];

export const RESOURCE_TYPE_ACTION_ORDER: readonly AgentResourceTypeAction[] = [
  "list",
  "read",
  "create",
  "update",
];

export type Reach = "unrestricted" | "read-only" | "changes-data";

export type CapabilityFacts = {
  reach: Reach;
  /** One scannable clause for a card. Always present, including for the unrestricted case. */
  headline: string;
  toolsAllowed: string[];
  toolsDenied: string[];
  skillsAllowed: string[];
  skillsDenied: string[];
  recordActionsAllowed: AgentRecordAction[];
  recordActionsDenied: AgentRecordAction[];
  resourceTypes: string[];
  /** Schema-level powers: what the agent may do to resource *type* definitions, and to which. */
  resourceTypeActionsAllowed: AgentResourceTypeAction[];
  resourceTypeActionsDenied: AgentResourceTypeAction[];
  resourceTypeNames: string[];
  /** True when the agent declared a restrictions block at all. */
  restricted: boolean;
};

function list<T extends string>(source: AllowDeny<T> | undefined, key: "allow" | "deny"): T[] {
  return source?.[key] ?? [];
}

function orderRecordActions(actions: readonly AgentRecordAction[]): AgentRecordAction[] {
  return RECORD_ACTION_ORDER.filter((action) => actions.includes(action));
}

function orderResourceTypeActions(
  actions: readonly AgentResourceTypeAction[]
): AgentResourceTypeAction[] {
  return RESOURCE_TYPE_ACTION_ORDER.filter((action) => actions.includes(action));
}

/**
 * Whether the agent can change anything.
 *
 * `allowMutating: false` is the explicit answer and always wins. Otherwise an agent given an
 * allow-list of actions is read-only exactly when none of them write — and that verdict has to weigh
 * *both* action lists, because an agent restricted to reading Records may still have been granted
 * `create` on resource types, which rewrites the schema those Records answer to. Calling that
 * "Reads only" would be a false reassurance about the more dangerous of the two powers. With neither
 * signal there is nothing holding it back, so it is reported as unrestricted rather than guessed at.
 */
export function reachOf(restrictions: AgentCapabilityRestrictions | undefined): Reach {
  if (!restrictions) return "unrestricted";

  if (restrictions.tools?.allowMutating === false) return "read-only";

  const allowedRecordActions = list(restrictions.records?.actions, "allow");
  const allowedTypeActions = list(restrictions.resourceTypes?.actions, "allow");
  if (allowedRecordActions.length > 0 || allowedTypeActions.length > 0) {
    const writes =
      allowedRecordActions.some((action) => WRITING_RECORD_ACTIONS.includes(action)) ||
      allowedTypeActions.some((action) => WRITING_RESOURCE_TYPE_ACTIONS.includes(action));
    return writes ? "changes-data" : "read-only";
  }

  if (restrictions.tools?.allowMutating === true) return "changes-data";

  const hasAnyRestriction =
    (restrictions.tools?.allow?.length ?? 0) > 0 ||
    (restrictions.tools?.deny?.length ?? 0) > 0 ||
    list(restrictions.records?.actions, "deny").length > 0 ||
    list(restrictions.resourceTypes?.actions, "deny").length > 0 ||
    (restrictions.records?.resourceTypes?.length ?? 0) > 0 ||
    (restrictions.resourceTypes?.names?.length ?? 0) > 0 ||
    (restrictions.skills?.allow?.length ?? 0) > 0 ||
    (restrictions.skills?.deny?.length ?? 0) > 0;

  return hasAnyRestriction ? "changes-data" : "unrestricted";
}

export const REACH_LABEL: Record<Reach, string> = {
  unrestricted: "Unrestricted",
  "read-only": "Reads only",
  "changes-data": "Changes data",
};

/**
 * The sentence a card shows under the description. It names the reach first because that is the
 * question people ask before any other, then what the agent is pointed at.
 */
function headlineOf(reach: Reach, resourceTypes: readonly string[], toolCount: number): string {
  if (reach === "unrestricted") {
    return "No limits declared — holds every capability its team allows.";
  }

  const verb = reach === "read-only" ? "Reads" : "Works on";
  const scope =
    resourceTypes.length === 0
      ? "any record it is given"
      : resourceTypes.length <= 2
        ? resourceTypes.join(" and ")
        : `${resourceTypes.length} record types`;
  const tools =
    toolCount > 0 ? `, limited to ${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : "";

  return `${verb} ${scope}${tools}.`;
}

export function capabilityFacts(
  restrictions: AgentCapabilityRestrictions | undefined
): CapabilityFacts {
  const reach = reachOf(restrictions);
  const toolsAllowed = list(restrictions?.tools, "allow");
  const resourceTypes = restrictions?.records?.resourceTypes ?? [];

  return {
    reach,
    headline: headlineOf(reach, resourceTypes, toolsAllowed.length),
    toolsAllowed,
    toolsDenied: list(restrictions?.tools, "deny"),
    skillsAllowed: list(restrictions?.skills, "allow"),
    skillsDenied: list(restrictions?.skills, "deny"),
    recordActionsAllowed: orderRecordActions(list(restrictions?.records?.actions, "allow")),
    recordActionsDenied: orderRecordActions(list(restrictions?.records?.actions, "deny")),
    resourceTypes,
    resourceTypeActionsAllowed: orderResourceTypeActions(
      list(restrictions?.resourceTypes?.actions, "allow")
    ),
    resourceTypeActionsDenied: orderResourceTypeActions(
      list(restrictions?.resourceTypes?.actions, "deny")
    ),
    resourceTypeNames: restrictions?.resourceTypes?.names ?? [],
    restricted: restrictions !== undefined,
  };
}

/** Domain buckets in reading order, with unlabelled agents gathered last rather than dropped. */
export const UNGROUPED_DOMAIN = "Other";

export function groupByDomain<T extends AgentSummary>(agents: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const agent of agents) {
    const key = agent.domain ?? UNGROUPED_DOMAIN;
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }

  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNGROUPED_DOMAIN) return 1;
    if (b === UNGROUPED_DOMAIN) return -1;
    return a.localeCompare(b);
  });
}

/**
 * Whether domain headings are worth showing.
 *
 * One agent per domain is not a hierarchy, it is the same list with a heading wedged above every
 * row — it triples the vertical cost and organizes nothing. Headings earn their place only once
 * some domain actually collects more than one agent; below that the card carries its own domain
 * and the grid stays flat.
 */
export function shouldGroupByDomain(groups: readonly [string, unknown[]][]): boolean {
  return groups.some(([, members]) => members.length > 1);
}

export function agentDisplayName(agent: Pick<AgentSummary, "name" | "label">): string {
  return agent.label ?? agent.name;
}

/**
 * Free-text match across the fields someone would actually type: what it is called, what it does,
 * and what it is pointed at. Matching resource types is what lets "stars" find the sync agent.
 */
export function matchesQuery(agent: AgentSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;

  const haystack = [
    agent.name,
    agent.label,
    agent.domain,
    agent.description,
    ...(agent.capabilityRestrictions?.records?.resourceTypes ?? []),
  ];

  return haystack.some((value) => value?.toLowerCase().includes(needle));
}
