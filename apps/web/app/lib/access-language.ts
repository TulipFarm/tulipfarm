/*
 * The authz API speaks in principals, grants, actions and resource types. A person running a
 * business does not, and an access screen that shows them `allow any action on platform.kv` is
 * asking them to learn our schema before they can let someone read the menu.
 */

import type { AuthzGrant, AuthzRole } from "./authz";
import type { UserStatus } from "./users";

export type AccessArea = {
  id: string;
  label: string;
  blurb: string;
};

type AreaRule = AccessArea & {
  /** Exact resource types this area owns. */
  types: readonly string[];
  prefixes?: readonly string[];
};

/*
 * Ordered most-specific first: `record` must win before any prefix rule could claim it. The
 * types listed here are the live vocabulary from `apps/api/src/identity/roles.ts` — when a
 * surface adds a new resource type, it belongs in one of these areas or it will render as its
 * raw name.
 */
const AREA_RULES: readonly AreaRule[] = [
  {
    id: "everything",
    label: "Everything",
    blurb: "Every part of the business, with nothing held back.",
    types: ["*"],
  },
  {
    id: "records",
    label: "Records",
    blurb: "Customers, orders, tickets and any other list you keep.",
    types: ["record"],
    prefixes: ["record"],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    blurb: "Documents and notes your assistants are allowed to read.",
    types: ["platform.knowledge", "knowledge_source"],
  },
  {
    id: "everyday",
    label: "Everyday work",
    blurb: "Chat, forms, feedback and the day-to-day screens.",
    types: [
      "chat",
      "activity",
      "feedback",
      "form",
      "preference",
      "onboarding",
      "platform.frontend",
      "platform.artifact",
      "platform.state",
      "platform.task",
      "platform.time",
      "surface",
      "platform.surface",
      "soul.surface_component",
    ],
  },
  {
    id: "automations",
    label: "Assistants and automations",
    blurb: "The assistants, skills and routines that do work for you.",
    types: [
      "soul.agent",
      "platform.agent",
      "soul.routine",
      "soul.skill",
      "trigger",
      "platform.memory",
    ],
  },
  {
    id: "setup",
    label: "Business setup",
    blurb: "How the business is described, and what kinds of records exist.",
    types: [
      "soul",
      "soul.repo",
      "soul.resource_type",
      "soul.business_profile",
      "soul.publication",
      "platform.kv",
      "kv_user",
      "kv_system",
      "llm_config",
      "setup",
    ],
  },
  {
    id: "apps",
    label: "Connected apps",
    blurb: "Slack, GitHub, Google Docs and anything else you link up.",
    types: ["integration", "secret"],
    prefixes: ["integration", "tool"],
  },
  {
    id: "people",
    label: "People and access",
    blurb: "Who works here, and what each of them is allowed to do.",
    types: ["user", "authz", "identity", "api_token", "auth_session"],
  },
  {
    id: "approvals",
    label: "Approvals",
    blurb: "Requests waiting for a yes or a no.",
    types: ["approval"],
  },
  {
    id: "owner",
    label: "Owner tools",
    blurb: "Activity history, audit records and system operations.",
    types: ["operations", "observability", "audit"],
  },
];

/** The area a resource type belongs to, or `null` when we do not recognise it. */
export function areaForResourceType(resourceType: string): AccessArea | null {
  const rule = AREA_RULES.find((candidate) => matchesArea(candidate, resourceType));
  if (!rule) return null;
  const { id, label, blurb } = rule;
  return { id, label, blurb };
}

function matchesArea(rule: AreaRule, resourceType: string): boolean {
  if (rule.types.includes(resourceType)) return true;
  return [...rule.types, ...(rule.prefixes ?? [])].some(
    (prefix) => prefix !== "*" && resourceType.startsWith(`${prefix}.`)
  );
}

export function accessAreas(): readonly AccessArea[] {
  return AREA_RULES.map(({ id, label, blurb }) => ({ id, label, blurb }));
}

export function describeResourceType(resourceType: string): string {
  if (resourceType === "*") return "everything";
  if (resourceType === "record") return "records";

  if (resourceType.startsWith("record.")) {
    return `${humanize(resourceType.slice("record.".length))} records`;
  }
  if (resourceType.startsWith("integration.")) {
    return `the ${providerName(resourceType.slice("integration.".length))} connection`;
  }
  if (resourceType.startsWith("tool.")) {
    return `the ${humanize(resourceType.slice("tool.".length))} tool`;
  }

  const area = areaForResourceType(resourceType);
  return area ? area.label.toLowerCase() : humanize(resourceType).toLowerCase();
}

export function describeAction(action: string): string {
  if (action === "*") return "Full access to";

  const verb = action.includes(".") ? (action.split(".").pop() ?? action) : action;
  switch (verb) {
    case "read":
    case "list":
    case "get":
    case "search":
    case "preview":
      return "View";
    case "create":
    case "add":
    case "write":
    case "push":
    case "connect":
    case "redeem":
      return "Add to";
    case "update":
    case "set_domain":
    case "rotate":
    case "assign":
      return "Change";
    case "delete":
    case "delete_domained":
    case "remove":
    case "revoke":
    case "disconnect":
    case "disable":
      return "Remove from";
    case "explain":
      return "Look into";
    default:
      return humanize(verb);
  }
}

/** One grant as a sentence fragment. */
export function describeGrant(grant: AuthzGrant): string {
  if (grant.action === "*") {
    if (grant.resourceType === "*") return "Do anything";
    return `Manage ${describeResourceType(grant.resourceType)}`;
  }
  return `${describeAction(grant.action)} ${describeGrantObject(grant)}`;
}

/*
 * A wildcard resource type does not mean "everything in the business" — it means the grant is
 * not narrowed to one resource, and the action already says what it reaches. When the action
 * carries a family, that family names the object; only an action with no family of its own
 * falls back to "everything".
 */
function describeGrantObject(grant: AuthzGrant): string {
  return describeResourceType(grantScope(grant));
}

/**
 * A wildcard is a scope rather than a scale, so the action's own family stands in for it; only
 * an action with no family falls back to the wildcard.
 */
function grantScope(grant: AuthzGrant): string {
  if (grant.resourceType !== "*") return grant.resourceType;
  const family = grant.action.includes(".")
    ? grant.action.slice(0, grant.action.lastIndexOf("."))
    : null;
  return family ?? "*";
}

export type RoleSummary = {
  title: string;
  blurb: string;
  areas: AccessArea[];
  unrestricted: boolean;
};

const BUILTIN_ROLE_COPY: Readonly<Record<string, { title: string; blurb: string }>> = {
  owner: {
    title: "Owner",
    blurb: "Runs the business. Can do anything, including managing access.",
  },
  admin: { title: "Full access", blurb: "Can do anything, including managing people and access." },
  member: { title: "Everyday access", blurb: "Day-to-day work. Cannot manage people or settings." },
};

/**
 * An authored level carries the name its author typed; when it carries none — every built-in,
 * and any Soul Role written by hand without a `displayName` — the id is humanized instead,
 * because a bare UUID tells the owner nothing.
 */
export function roleTitle(roleId: string, displayName?: string | null): string {
  const builtin = BUILTIN_ROLE_COPY[roleId]?.title;
  if (builtin) return builtin;
  return displayName?.trim() || humanize(roleId);
}

export function roleNamer(roles: readonly AuthzRole[]): (roleId: string) => string {
  const names = new Map(roles.map((role) => [role.id, role.displayName]));
  return (roleId) => roleTitle(roleId, names.get(roleId));
}

export function summarizeRole(role: AuthzRole): RoleSummary {
  const allows = role.grants.filter((grant) => grant.effect === "allow");
  /*
   * A wildcard resource type alone does not make a Role unrestricted — it makes the grant
   * un-narrowed, and the action still says what it reaches. `member` allows `record.create` on
   * `*`, which is "add records anywhere", not "do anything": badging it Unrestricted
   * contradicted its own blurb one line above.
   */
  const unrestricted = allows.some((grant) => grant.action === "*" && grant.resourceType === "*");

  const areas: AccessArea[] = [];
  for (const grant of allows) {
    const area = areaForResourceType(grantScope(grant));
    if (area && !areas.some((seen) => seen.id === area.id)) areas.push(area);
  }

  const copy = BUILTIN_ROLE_COPY[role.id];
  return {
    title: roleTitle(role.id, role.displayName),
    blurb: copy?.blurb ?? defaultBlurb(areas, unrestricted),
    areas,
    unrestricted,
  };
}

function defaultBlurb(areas: readonly AccessArea[], unrestricted: boolean): string {
  if (unrestricted) return "Can do anything.";
  if (areas.length === 0) return "Grants nothing on its own.";
  return `Covers ${joinWords(areas.map((area) => area.label.toLowerCase()))}.`;
}

/*
 * What an account's status means, said the way an owner would say it. A turned-off account
 * offers no link — redeeming one would hand back an identity an owner deliberately switched
 * off, which is the one combination that must never be reachable.
 */
export type AccountStatusCopy = {
  /** Badge text. `null` for the ordinary case, which needs no badge at all. */
  badge: string | null;
  tone: "neutral" | "warning" | "danger";
  /** Button that issues a fresh sign-in link, or `null` when issuing one would be wrong. */
  linkLabel: string | null;
  toggleLabel: string;
  nextStatus: "active" | "disabled";
};

export const ACCOUNT_STATUS: Readonly<Record<UserStatus, AccountStatusCopy>> = {
  active: {
    badge: null,
    tone: "neutral",
    linkLabel: "Send a password reset link",
    toggleLabel: "Turn off this account",
    nextStatus: "disabled",
  },
  invited: {
    badge: "Invite not accepted",
    tone: "warning",
    linkLabel: "Send a new invite link",
    toggleLabel: "Turn off this account",
    nextStatus: "disabled",
  },
  disabled: {
    badge: "Cannot sign in",
    tone: "danger",
    linkLabel: null,
    toggleLabel: "Let them sign in again",
    nextStatus: "active",
  },
};

export function joinWords(words: readonly string[]): string {
  if (words.length === 0) return "";
  if (words.length === 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/*
 * Kept short on purpose: an owner arrives asking "why couldn't they do this", not composing a
 * policy query. The exact action and resource strings stay visible beneath the sentence and
 * overridable in the advanced disclosure, so nothing an operator could ask before is lost.
 */
export const CHECKABLE_VERBS: readonly { value: string; label: string }[] = [
  { value: "read", label: "view" },
  { value: "create", label: "add" },
  { value: "update", label: "change" },
  { value: "delete", label: "delete" },
];

/**
 * Things whose action vocabulary is not CRUD, mapped verb by verb to the action the gate really
 * evaluates. `grantMatches` compares the action as an exact string, so a composed
 * `integration.create` — an action that exists nowhere — matches neither the allows nor the
 * denies that describe the surface.
 */
const THING_ACTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  integration: {
    read: "integration.read",
    create: "integration.connect",
    delete: "integration.remove",
  },
  secret: {
    read: "secret.read",
    create: "secret.write",
    update: "secret.write",
    delete: "secret.delete",
  },
  authz: {
    read: "authz.role.read",
    create: "authz.role.assign",
    delete: "authz.role.revoke",
  },
};

/**
 * Things worth checking that are not Records, named in the owner's words and paired with the
 * exact resource type the decision function evaluates.
 */
export const CHECKABLE_THINGS: readonly { value: string; label: string }[] = [
  { value: "platform.knowledge", label: "The knowledge base" },
  { value: "chat", label: "Chat" },
  /*
   * The Record family itself, not any one type. An access level built from the Records
   * capabilities grants `record.create` on resource type `record`, so without this entry the
   * one thing an owner is most likely to grant is the one thing this screen could not be asked
   * about.
   */
  { value: "record", label: "Records of every kind" },
  { value: "soul.agent", label: "Assistants" },
  { value: "soul.routine", label: "Routines" },
  { value: "soul.skill", label: "Skills" },
  { value: "soul.resource_type", label: "The kinds of records that exist" },
  { value: "integration", label: "Connected apps" },
  { value: "integration.github", label: "GitHub" },
  { value: "integration.slack", label: "Slack" },
  { value: "approval", label: "Approvals" },
  { value: "user", label: "People's accounts" },
  { value: "authz", label: "Access settings" },
  { value: "secret", label: "Secrets" },
  { value: "audit", label: "Audit history" },
];

/**
 * Records are the one family whose actions are namespaced by the family rather than by the
 * individual type — a grant reads `record.read`, never `record.customer.read` — so scoping the
 * verb to the type would produce an action no grant can ever match and report a denial that the
 * real gate would not produce. Returns null when the verb has no counterpart, which the caller
 * must not send.
 */
export function actionFor(resourceType: string, verb: string): string | null {
  const named = THING_ACTIONS[resourceType];
  if (named) return named[verb] ?? null;
  if (resourceType === "record" || resourceType.startsWith("record.")) return `record.${verb}`;
  return `${resourceType}.${verb}`;
}

export function verbsFor(resourceType: string): readonly { value: string; label: string }[] {
  if (!resourceType) return CHECKABLE_VERBS;
  return CHECKABLE_VERBS.filter((verb) => actionFor(resourceType, verb.value) !== null);
}

function humanize(value: string): string {
  const words = value.replaceAll(/[._-]+/g, " ").trim();
  if (words.length === 0) return value;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  github: "GitHub",
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  google_docs: "Google Docs",
  googledocs: "Google Docs",
  confluence: "Confluence",
};

function providerName(slug: string): string {
  return PROVIDER_NAMES[slug] ?? humanize(slug);
}
