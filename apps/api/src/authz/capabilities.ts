/**
 * Derive from Tool authorization declarations; report unexpressible grants instead of offering
 * broken ones.
 */

import type { ToolDef } from "@tulipfarm/tool-host";

/** Copied from RoleSchema; tests guard drift without TypeBox runtime coupling. */
export const AUTHORABLE_ACTION = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
export const AUTHORABLE_RESOURCE = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)?$/;

export interface Capability {
  /** Stable id for the UI; equal to the action, which is unique per capability. */
  readonly id: string;
  readonly action: string;
  readonly resourceTypes: readonly string[];
  readonly label: string;
  readonly changesThings: boolean;
  readonly tools: readonly string[];
}

export interface CapabilityArea {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly Capability[];
}

export interface UnavailableCapability {
  readonly action: string;
  readonly resourceTypes: readonly string[];
  readonly tools: readonly string[];
  readonly reason: "action_not_authorable" | "resource_not_authorable" | "no_resource_declared";
}

export interface CapabilityCatalog {
  readonly areas: readonly CapabilityArea[];
  readonly unavailable: readonly UnavailableCapability[];
}

const AREA_LABELS: Readonly<Record<string, string>> = {
  github: "GitHub",
  slack: "Slack",
  soul: "Your business's setup",
  platform: "How assistants work",
  frontend: "Moving around the app",
  kv: "Saved values",
  knowledge: "The knowledge base",
  memory: "What assistants remember",
  record: "Records",
  identity: "Sign-in and API clients",
  integration: "Connected apps",
  secret: "Secrets",
  surface: "What gets shown",
};

const VERB_LABELS: Readonly<Record<string, string>> = {
  list: "See every",
  get: "See",
  read: "See",
  search: "Search",
  create: "Add",
  add: "Add",
  write: "Change",
  update: "Change",
  patch: "Change",
  set: "Change",
  delete: "Delete",
  remove: "Delete",
  send: "Send",
  post: "Post",
  comment: "Comment on",
  merge: "Merge",
  close: "Close",
  connect: "Connect",
  disconnect: "Disconnect",
  run: "Run",
  execute: "Run",
  invoke: "Run",
  publish: "Publish",
  activate: "Turn on",
  deactivate: "Turn off",
};

/** Verbs that only look at something. Everything else is treated as a change — fail safe. */
const READ_ONLY_VERBS: ReadonlySet<string> = new Set(["list", "get", "read", "search"]);

function humanize(segment: string): string {
  return segment.replace(/[_-]+/g, " ").trim();
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function areaLabel(area: string): string {
  return AREA_LABELS[area] ?? titleCase(humanize(area));
}

export function capabilityLabel(action: string): string {
  const segments = action.split(".");
  const verb = segments[segments.length - 1] ?? action;
  const middle = segments.slice(1, -1);
  const verbLabel = VERB_LABELS[verb] ?? titleCase(humanize(verb));
  if (middle.length === 0 && /[_-]/.test(verb)) {
    return verbLabel;
  }
  const object = middle.length > 0 ? middle.map(humanize).join(" ") : humanize(segments[0] ?? "");
  return `${verbLabel} ${object}`.trim();
}

function changesThings(action: string, mutating: boolean): boolean {
  const verb = action.split(".").pop() ?? "";
  // The Tool's own `mutating` flag wins when it says yes; the verb is only a fallback for Tools
  // that report `mutating: false` while carrying a writing verb.
  return mutating || !READ_ONLY_VERBS.has(verb);
}

interface Accumulated {
  action: string;
  resourceTypes: Set<string>;
  tools: Set<string>;
  changesThings: boolean;
}

/** Key by action so multiple Tools requiring the same action become one grantable capability. */
export function buildCapabilityCatalog(tools: readonly ToolDef[]): CapabilityCatalog {
  const byAction = new Map<string, Accumulated>();
  const unavailable = new Map<string, UnavailableCapability>();

  for (const tool of tools) {
    const authorization = tool.definition?.authorization;
    if (authorization === undefined) continue;
    const action = authorization.action;
    const resourceTypes = [...new Set(authorization.resources ?? [])];

    const reason: UnavailableCapability["reason"] | undefined = !AUTHORABLE_ACTION.test(action)
      ? "action_not_authorable"
      : resourceTypes.length === 0
        ? "no_resource_declared"
        : resourceTypes.some((type) => !AUTHORABLE_RESOURCE.test(type))
          ? "resource_not_authorable"
          : undefined;

    if (reason !== undefined) {
      const existing = unavailable.get(action);
      unavailable.set(action, {
        action,
        resourceTypes,
        tools: [...new Set([...(existing?.tools ?? []), tool.name])].sort(),
        reason,
      });
      continue;
    }

    const entry = byAction.get(action) ?? {
      action,
      resourceTypes: new Set<string>(),
      tools: new Set<string>(),
      changesThings: false,
    };
    for (const type of resourceTypes) entry.resourceTypes.add(type);
    entry.tools.add(tool.name);
    // Any Tool that changes things makes the capability one that changes things: the grant is
    // shared, so the most powerful use of it is what an owner is actually agreeing to.
    entry.changesThings ||= changesThings(action, tool.mutating);
    byAction.set(action, entry);
  }

  const areas = new Map<string, Capability[]>();
  for (const entry of byAction.values()) {
    const area = entry.action.split(".")[0] ?? entry.action;
    const list = areas.get(area) ?? [];
    list.push({
      id: entry.action,
      action: entry.action,
      resourceTypes: [...entry.resourceTypes].sort(),
      label: capabilityLabel(entry.action),
      changesThings: entry.changesThings,
      tools: [...entry.tools].sort(),
    });
    areas.set(area, list);
  }

  return {
    areas: [...areas.entries()]
      .map(([id, capabilities]) => ({
        id,
        label: areaLabel(id),
        capabilities: [...capabilities].sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    unavailable: [...unavailable.values()].sort((a, b) => a.action.localeCompare(b.action)),
  };
}
