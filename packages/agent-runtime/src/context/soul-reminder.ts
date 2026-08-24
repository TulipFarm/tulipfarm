import { type AuthorityLayer, decideEffectivePermission } from "@tulipfarm/authz";
import { MAX_CUSTOM_INSTRUCTIONS_CHARS } from "./assemble";

/**
 * What this instance's Soul holds, told to the Agent rather than looked up.
 *
 * This is the one thing the Tool-reached model in `README.md` cannot answer well: an Agent that
 * does not know a Skill exists never calls `skill_list` to find it, so the capability is invisible
 * until the participant names it. A list of names and descriptions is also the rare block that
 * ages gracefully — it changes only when the Soul is written, and it is rebuilt every Turn.
 *
 * It is narrowed to what this Turn's subject may actually reach, so the catalogue can never
 * disclose the existence of an artifact the Tools would refuse to open.
 */

/** One Soul artifact as the reminder names it: what to call it, and what it is for. */
export interface SoulReminderEntry {
  readonly name: string;
  readonly description: string;
}

/** Who the business is, as `soul.yaml` states it. Every field is optional and often unset. */
export interface SoulBusinessDetails {
  readonly name?: string;
  readonly description?: string;
  readonly website?: string;
}

/** The Soul catalogue by artifact kind. Structural on purpose — this package may not import Soul. */
export interface SoulReminderCatalogue {
  readonly business?: SoulBusinessDetails;
  readonly agents: readonly SoulReminderEntry[];
  readonly skills: readonly SoulReminderEntry[];
  readonly resourceTypes: readonly SoulReminderEntry[];
  readonly routines: readonly SoulReminderEntry[];
  readonly integrations: readonly SoulReminderEntry[];
}

/**
 * What this instance holds about the *person*, as opposed to the Soul.
 *
 * Separate from the catalogue because it is scoped to one subject rather than to the deployment,
 * and it is gated on a different authority: reading a Skill's name and reading someone's Memory
 * are not the same disclosure.
 */
export interface SoulReminderPersonal {
  /** The user's Memory Document, already rendered as Markdown. */
  readonly memory?: string;
  /** Standing instructions the user wrote themselves, in their own words. */
  readonly customInstructions?: string;
}

/** The authority that admits a singleton block — one that names no artifact to scope a grant to. */
interface SingletonAuthorization {
  readonly resourceType: string;
  readonly actions: readonly string[];
}

/** `get_business_profile` reads `soul.yaml` under this action, so the block discloses no more. */
const BUSINESS_AUTHORIZATION: SingletonAuthorization = {
  resourceType: "soul",
  actions: ["soul.business_profile.read"],
};

/**
 * Both personal blocks ride on the Memory read.
 *
 * `get_memory` already returns the document and the standing instructions together, under this one
 * action, on the stated grounds that they answer the same question. Gating them apart here would
 * invent a boundary the Tool does not have.
 */
const PERSONAL_AUTHORIZATION: SingletonAuthorization = {
  resourceType: "platform.memory",
  actions: ["memory.document.read"],
};

/** One rendered section, and the authority that admits an entry to it. */
interface SoulReminderSection {
  /** `business` is excluded: it is one record, not a list, and has its own authorization. */
  readonly key: Exclude<keyof SoulReminderCatalogue, "business">;
  readonly tag: string;
  /** The `resourceType` the owning Tool family declares; a grant is written against this name. */
  readonly resourceType: string;
  /** Any one of these admits the artifact — read, write or run all imply "you know it exists". */
  readonly actions: readonly string[];
}

/**
 * Sections in render order, each paired with the authority that admits an entry.
 *
 * The actions are the ones the owning Tool families declare, so an artifact appears here exactly
 * when some Tool would let this subject do something with it. Adding a Tool for a kind means
 * adding its action here, or the Tool becomes reachable while the artifact stays invisible.
 */
export const SOUL_REMINDER_SECTIONS: readonly SoulReminderSection[] = [
  {
    key: "skills",
    tag: "available-skills",
    resourceType: "soul.skill",
    actions: [
      "soul.skill.list",
      "soul.skill.read",
      "soul.skill.create",
      "soul.skill.update",
      "soul.skill.delete",
      "soul.skill.activate",
      "platform.skill.load",
      "platform.skill.call",
    ],
  },
  {
    key: "agents",
    tag: "available-agents",
    resourceType: "soul.agent",
    actions: [
      "soul.agent.list",
      "soul.agent.read",
      "soul.agent.create",
      "soul.agent.update",
      "soul.agent.delete",
    ],
  },
  {
    key: "resourceTypes",
    tag: "available-resources",
    resourceType: "soul.resource_type",
    actions: [
      "soul.resource_type.list",
      "soul.resource_type.read",
      "soul.resource_type.create",
      "soul.resource_type.update",
    ],
  },
  {
    key: "routines",
    tag: "available-routines",
    resourceType: "soul.routine",
    actions: [
      "platform.routine.list",
      "platform.routine.trigger",
      "platform.routine.forge",
      "platform.routine.delete",
    ],
  },
  {
    key: "integrations",
    tag: "available-integrations",
    resourceType: "integration",
    actions: [
      "integration.read",
      "integration.connect",
      "integration.disconnect",
      "integration.remove",
    ],
  },
];

const EMPTY_CATALOGUE: SoulReminderCatalogue = {
  agents: [],
  skills: [],
  resourceTypes: [],
  routines: [],
  integrations: [],
};

/**
 * Whether this subject may reach one named artifact at all.
 *
 * The name travels as `recordId`, which is the dimension `recordSelector` narrows, so a grant can
 * name one artifact — that is what lets a deny hide a single Agent without hiding the rest. No
 * `domain` is sent: role grants for these types are authored domainless, and `grantMatches` treats
 * a domainless grant and a domained request as a non-match.
 */
function reachable(
  layers: readonly AuthorityLayer[],
  section: SoulReminderSection,
  name: string,
  now: Date
): boolean {
  return section.actions.some(
    (action) =>
      decideEffectivePermission(
        layers,
        { action, resourceType: section.resourceType, recordId: name },
        now
      ).allowed
  );
}

/**
 * Whether this subject may reach a block that names no artifact.
 *
 * No `recordId` travels, because there is no artifact name to scope one to. An unscoped grant
 * therefore matches and a `recordSelector`-scoped grant does not — which is the fail-closed
 * direction: a grant narrowed to one named Record was never about this singleton.
 */
function singletonReachable(
  layers: readonly AuthorityLayer[],
  authorization: SingletonAuthorization,
  now: Date
): boolean {
  return authorization.actions.some(
    (action) =>
      decideEffectivePermission(layers, { action, resourceType: authorization.resourceType }, now)
        .allowed
  );
}

/**
 * Narrows the catalogue to the artifacts this Turn's subject may reach.
 *
 * Fail-closed by construction: no layers denies everything, which renders no reminder at all and
 * leaves the Turn behaving exactly as it did before this block existed.
 */
export function filterSoulCatalogue(
  catalogue: SoulReminderCatalogue,
  layers: readonly AuthorityLayer[],
  now: Date = new Date()
): SoulReminderCatalogue {
  const filtered: Record<string, readonly SoulReminderEntry[]> = {};
  for (const section of SOUL_REMINDER_SECTIONS) {
    filtered[section.key] = (catalogue[section.key] ?? []).filter((entry) =>
      reachable(layers, section, entry.name, now)
    );
  }
  const business =
    catalogue.business !== undefined && singletonReachable(layers, BUSINESS_AUTHORIZATION, now)
      ? catalogue.business
      : undefined;
  return {
    ...EMPTY_CATALOGUE,
    ...filtered,
    ...(business === undefined ? {} : { business }),
  };
}

/**
 * Narrows the personal blocks to what this Turn's subject may read.
 *
 * This is the subject's own Memory in the subject's own chat, so in practice the gate passes; it
 * is applied anyway because the alternative is a block whose disclosure rule lives nowhere.
 */
export function filterSoulPersonal(
  personal: SoulReminderPersonal,
  layers: readonly AuthorityLayer[],
  now: Date = new Date()
): SoulReminderPersonal {
  if (!singletonReachable(layers, PERSONAL_AUTHORIZATION, now)) return {};
  return personal;
}

/** Longest description the reminder carries; a Tool reads the whole thing when it matters. */
const MAX_DESCRIPTION_CHARS = 200;

/**
 * Flattens one authored string into a single safe line.
 *
 * Descriptions are authored — by a user in the UI, or by an Agent writing the Soul — so they are
 * the one part of this block that an attacker can choose. Stripping angle brackets stops a
 * description closing the tag it sits inside and continuing as if it were the platform speaking;
 * collapsing newlines stops it forging a second entry.
 */
function line(value: string): string {
  const flattened = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return flattened.length > MAX_DESCRIPTION_CHARS
    ? `${flattened.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()}…`
    : flattened;
}

/**
 * Marks a section the subject may reach nothing in. It has to be said out loud: a silently
 * omitted section reads as "unknown", and an Agent resolves unknown by spending a Tool call.
 */
const EMPTY_SECTION = "(none)";

/** Longest Memory Document the reminder carries; `get_memory` returns the whole thing. */
const MAX_MEMORY_CHARS = 8_000;

/**
 * Flattens one authored *block* into safe lines, keeping the line breaks.
 *
 * `line()` cannot be used here: the Memory Document is Markdown whose headings and one-fact-per-
 * line grammar are load-bearing, and collapsing it to a single line would destroy the structure
 * `update_memory` matches against. So newlines survive and only the tag-forging characters go.
 *
 * Angle brackets are still stripped per line, for the same reason as in `line()` — this is the
 * one part of the reminder whose text a user or a compromised Agent chooses, and a body that can
 * write `</user-memory>` can continue as if it were the platform speaking.
 */
function blockText(value: string, limit: number): string {
  const cleaned = value
    .replace(/[<>]/g, "")
    .split("\n")
    .map((entry) => entry.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit).trimEnd()}…` : cleaned;
}

function renderBlock(tag: string, body: string): string {
  return `<${tag}>\n${body.length === 0 ? EMPTY_SECTION : body}\n</${tag}>`;
}

/** Renders the business as labelled lines, so an unset field is visibly unset, not missing. */
function renderBusiness(business: SoulBusinessDetails | undefined): string {
  const fields: ReadonlyArray<readonly [string, string | undefined]> = [
    ["name", business?.name],
    ["description", business?.description],
    ["website", business?.website],
  ];
  const rendered = fields
    .map(([label, value]) => [label, line(value ?? "")] as const)
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
  return renderBlock("business-details", rendered);
}

function renderSection(tag: string, entries: readonly SoulReminderEntry[]): string {
  const body =
    entries.length === 0
      ? EMPTY_SECTION
      : entries
          .map((entry) => {
            const name = line(entry.name);
            const description = line(entry.description);
            return description.length === 0 ? name : `${name}: ${description}`;
          })
          .join("\n");
  return `<${tag}>\n${body}\n</${tag}>`;
}

/**
 * Renders the reminder. Always renders every block, empty ones included.
 *
 * Omitting an empty section defeats the point of the block. The Agent cannot tell an absent
 * section from a section nobody thought to send, so it calls `list_resource_types` to find out —
 * which is the exact Tool call this reminder exists to make unnecessary. "(none)" is the answer
 * that ends the question, and it is the truthful one at this boundary: what reaches this function
 * has already been narrowed to what the subject may reach, so an empty block means "nothing here
 * for you", which is what the subject would learn by calling the Tool anyway.
 *
 * `<soul>` holds only what the Soul repo defines. The business, the Memory and the standing
 * instructions are all facts the Agent needs *about the world it is working in* rather than
 * artifacts it can load, extend or call, so they sit alongside it. The business comes first
 * because every other block reads differently once you know whose business it is.
 */
export function renderSoulReminder(
  catalogue: SoulReminderCatalogue,
  personal: SoulReminderPersonal = {}
): string {
  const soul = SOUL_REMINDER_SECTIONS.map((section) =>
    renderSection(section.tag, catalogue[section.key] ?? [])
  ).join("\n");
  const blocks = [
    renderBusiness(catalogue.business),
    `<soul>\n${soul}\n</soul>`,
    renderBlock("user-memory", blockText(personal.memory ?? "", MAX_MEMORY_CHARS)),
    renderBlock(
      "custom-instructions",
      blockText(personal.customInstructions ?? "", MAX_CUSTOM_INSTRUCTIONS_CHARS)
    ),
  ];
  return `<system-reminder>\n${blocks.join("\n")}\n</system-reminder>`;
}
