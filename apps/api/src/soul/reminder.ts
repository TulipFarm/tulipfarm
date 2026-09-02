import {
  filterSoulCatalogue,
  filterSoulPersonal,
  filterSoulPinned,
  renderSoulReminder,
  type SoulBusinessDetails,
  type SoulReminderPersonal,
  type SoulReminderPinned,
} from "@tulipfarm/agent-runtime";
import type { AuthorityLayer } from "@tulipfarm/authz";
import type { AgentCapabilityRestrictions } from "@tulipfarm/schema";
import { buildSoulCatalogue, type RegistryEntry, type SoulLoader } from "@tulipfarm/soul";
import { type AuthorityPrincipal, agentCanUseSkill, principalKindOf } from "@tulipfarm/tool-host";

/**
 * The one layer read the Soul reminder needs; `LiveAuthorityLayerResolver` satisfies it.
 *
 * Declared as a port rather than taking the class, so callers depend on the question they ask and
 * not on how the durable answer is assembled.
 */
export interface SubjectAuthorityLayers {
  resolvePrincipalLayer(name: string, principal: AuthorityPrincipal): Promise<AuthorityLayer>;
}

/** The Memory read the reminder needs; `MemoryDocumentRepo` satisfies it. */
export interface MemoryDocumentReader {
  render(businessId: string, userId: string): Promise<string>;
}

/**
 * The marketplace catalog read the reminder needs; `loadIntegrationRegistry` satisfies it.
 *
 * Every business reads the same registry, so this takes no arguments — unlike `MemoryDocumentReader`,
 * which is scoped per subject.
 */
export interface IntegrationRegistryReader {
  load(): Promise<ReadonlyMap<string, RegistryEntry>>;
}

export interface SoulReminderInput {
  readonly authorityLayers?: SubjectAuthorityLayers;
  readonly soulLoader?: SoulLoader;
  /** Absent leaves `<user-memory>` empty rather than failing the Turn. */
  readonly memory?: MemoryDocumentReader;
  /** Absent leaves `<custom-instructions>` empty rather than failing the Turn. */
  readonly customInstructions?: (userId: string) => Promise<string | undefined>;
  /** Absent leaves `<available-integrations>` naming only what this Soul has connected. */
  readonly integrationRegistry?: IntegrationRegistryReader;
  readonly businessId: string;
  readonly subjectId: string;
  readonly subjectKind: string;
  /**
   * This Turn's Agent's authored restrictions, so the catalogue never names a Skill the Agent
   * would be refused at dispatch. Absent leaves the catalogue unrestricted.
   */
  readonly agentRestrictions?: AgentCapabilityRestrictions;
  /** What the participant pointed at in the composer. Narrowed to the catalogue before rendering. */
  readonly pinned?: SoulReminderPinned;
  readonly now: Date;
}

/** Reads a manifest field as non-blank text, so an unset key and a blank one behave alike. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Projects `soul.yaml` to the business block.
 *
 * Reads the manifest the loader already parsed rather than the file, so the reminder cannot
 * disagree with the Soul the rest of the Turn is running against. The keys are the ones
 * `get_business_profile` and `GET /api/v1/business` read, so all three tell the same story.
 */
function businessFrom(soulLoader: SoulLoader | undefined): SoulBusinessDetails | undefined {
  const manifest = soulLoader?.manifest;
  if (!manifest) return undefined;
  const name = text(manifest.businessName);
  const description = text(manifest.businessDescription);
  const website = text(manifest.businessWebsite);
  if (name === undefined && description === undefined && website === undefined) return undefined;
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(website === undefined ? {} : { website }),
  };
}

/**
 * Reads the subject's Memory and standing instructions.
 *
 * A failed read yields an empty block, never a failed Turn: this reminder is an optimisation over
 * `get_memory`, and losing it must cost the conversation nothing more than a Tool call.
 */
async function personalFor(input: SoulReminderInput): Promise<SoulReminderPersonal> {
  const [memory, customInstructions] = await Promise.all([
    input.memory?.render(input.businessId, input.subjectId).catch(() => undefined),
    input.customInstructions?.(input.subjectId).catch(() => undefined),
  ]);
  return {
    ...(memory === undefined ? {} : { memory }),
    ...(customInstructions === undefined ? {} : { customInstructions }),
  };
}

/**
 * Renders the Soul reminder for one subject, or `""` when no layer resolver is composed.
 *
 * Lives outside the Turn resolver because two callers must agree on it exactly: the Turn, which
 * sends it to the model, and `/chats/:id/debug-context`, which claims to show what the model got.
 * A second implementation there would drift, and a debug view that drifts is worse than none.
 *
 * Only the subject's own layer is intersected, not the Agent's. `ModelSelectorGate` runs its
 * user+agent intersection in shadow mode precisely because no Role grants an Agent principal
 * anything today, so enforcing that layer here would empty the reminder for everyone. This block
 * is a disclosure into the participant's chat, so the participant's authority is the right
 * boundary; every action it might tempt an Agent into is still gated by the full intersection at
 * the Tool.
 *
 * A subject kind that maps to no principal renders nothing, rather than intersecting an empty set,
 * which a careless reader could take for "allowed".
 *
 * The Agent's authored Skill restrictions *are* applied, which is not a contradiction of the
 * paragraph above: they are configuration on the Agent rather than a granted authority layer, and
 * omitting a Skill the Agent would be refused at dispatch keeps the catalogue from advertising a
 * capability this Turn cannot adopt.
 */
export async function resolveSoulReminder(input: SoulReminderInput): Promise<string> {
  const resolver = input.authorityLayers;
  if (resolver === undefined) return "";
  const kind = principalKindOf(input.subjectKind);
  if (kind === undefined) return "";
  const layer = await resolver.resolvePrincipalLayer("user", {
    id: input.subjectId,
    businessId: input.businessId,
    kind,
  });
  const business = businessFrom(input.soulLoader);
  const registry = await input.integrationRegistry?.load().catch(() => undefined);
  const loaded = buildSoulCatalogue(input.soulLoader, registry);
  const catalogue = {
    ...loaded,
    skills: loaded.skills.filter((entry) => agentCanUseSkill(input.agentRestrictions, entry.name)),
    ...(business === undefined ? {} : { business }),
  };
  const personal = await personalFor(input);
  const narrowed = filterSoulCatalogue(catalogue, [layer], input.now);
  return renderSoulReminder(
    narrowed,
    filterSoulPersonal(personal, [layer], input.now),
    filterSoulPinned(input.pinned ?? {}, narrowed)
  );
}
