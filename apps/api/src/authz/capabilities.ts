/**
 * The catalog of things a person can be *granted*, named in words a business owner recognises.
 *
 * # Why this is derived and not written down
 *
 * Six separate bugs on the access surface shared one shape: the UI composed an authorization string
 * that the gate never evaluates. `integration.create` was offered to an owner and matched nothing —
 * neither the allow that would have permitted it nor the explicit deny that should have refused it,
 * so a real deny rendered as "no rule matched" with a suggested remedy that could never work. The
 * cause was always a hand-maintained list restating a vocabulary that lives somewhere else.
 *
 * So nothing here is hand-maintained. Every capability is read off a Tool's own
 * `authorization` declaration — the exact `action` and `resources` that `authorizeToolIntent`
 * passes to `decideEffectivePermission`. If a Tool changes what authority it requires, this catalog
 * changes with it on the next boot, and a capability that cannot be expressed simply stops being
 * offered instead of being offered and silently failing.
 *
 * # Why some Tools are absent, and why that is the correct behaviour
 *
 * An authored Soul Role is validated by `RoleSchema` (`packages/schema/src/definitions/role.ts`),
 * which is deliberately stricter than the built-in deployment catalog: it rejects wildcard
 * authority so least privilege is the default, and it rejects the axes `grantMatches` compares
 * literally so a grant cannot be authored that matches nothing. A Tool whose action or resource
 * cannot pass those patterns therefore cannot be granted by an authored level at all.
 *
 * Such a Tool is reported in `unavailable` rather than dropped in silence. Offering it would
 * produce a level that validates, saves, and then denies every call — the invisible failure this
 * module exists to prevent. Hiding it without a word would leave an owner hunting for a capability
 * that is never coming. Naming it is the only honest option.
 */

import type { ToolDef } from "../tools/types";

/**
 * Copied deliberately, not imported: these are the patterns in `RoleSchema` that decide whether an
 * authored grant is expressible. `@tulipfarm/schema` exports the compiled schema rather than the
 * source patterns, and reaching into `RoleGrantSchema.properties` at runtime would couple this file
 * to TypeBox's emitted shape. `capabilities.test.ts` asserts these two constants still equal the
 * patterns the published schema carries, so a divergence fails a test rather than shipping a
 * catalog that offers grants the authoring endpoint will reject.
 */
export const AUTHORABLE_ACTION = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
export const AUTHORABLE_RESOURCE = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)?$/;

export interface Capability {
  /** Stable id for the UI; equal to the action, which is unique per capability. */
  readonly id: string;
  /** The exact action string the gate evaluates. Shown to the user only under "technical detail". */
  readonly action: string;
  /** The exact resource types the gate evaluates this action against. */
  readonly resourceTypes: readonly string[];
  /** Plain-language name, derived from the action. */
  readonly label: string;
  /** Whether granting this lets someone change something, as opposed to only look at it. */
  readonly changesThings: boolean;
  /** The Tools this capability comes from — how an owner recognises what they are granting. */
  readonly tools: readonly string[];
}

export interface CapabilityArea {
  /** First segment of the action — `github`, `slack`, `soul`. */
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
  /**
   * Capabilities a Tool requires but an authored level cannot express. Surfaced, not swallowed —
   * see the module comment.
   */
  readonly unavailable: readonly UnavailableCapability[];
}

/**
 * Area names an owner would not otherwise recognise from the raw action segment. This maps
 * *presentation only* — it can never change which action is granted, so a stale entry mislabels a
 * heading rather than misrouting authority. Anything absent falls back to the segment itself,
 * title-cased, so a new integration appears with a reasonable name the day it ships rather than
 * waiting for this map to be updated.
 */
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

/**
 * The trailing segment of an action is its verb by convention across every Tool in the repo
 * (`github.repository.list`, `slack.message.send`). Mapping the common ones to natural English is
 * presentation only, exactly as `AREA_LABELS` is; an unmapped verb is used as written, so a new
 * one reads slightly stiffly rather than being hidden or mislabelled.
 */
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

/**
 * Turns `github.pull_request.create` into "Add pull request".
 *
 * The object is every segment between the area and the verb. When there is none the last segment
 * has to carry both roles, and which reading is right depends on the segment:
 *
 * - `soul.publish` — a bare verb names nothing on its own, so the area becomes the object and it
 *   reads "Publish soul".
 * - `frontend.invoke_action` — a multi-word segment is already verb *and* object, so appending the
 *   area would produce "Invoke action frontend". It is used as written instead.
 */
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

/**
 * Builds the catalog from the live Tool registry.
 *
 * Tools are keyed by action rather than by name because authority is granted per action: two Tools
 * requiring `github.issue.create` are one capability to grant, and listing it twice would ask an
 * owner to make the same decision twice with no way to tell the entries apart.
 */
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
