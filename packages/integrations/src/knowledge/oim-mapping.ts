/**
 * Reads provider responses into the shapes Knowledge indexes, and resolves provider principals
 * into TulipFarm ones.
 *
 * Two different failure postures live here on purpose:
 *
 * - **Reading an ACL fails closed.** An entry the manifest cannot interpret means the readers of
 *   this item are unknown, and an item indexed with unknown readers is an item the index may show
 *   to someone the provider would refuse. The whole ACL is reported unverifiable.
 * - **Resolving one principal drops it.** A provider user with no TulipFarm principal is somebody
 *   who cannot ask a question here anyway; dropping the entry narrows access, so it is safe.
 */

import { canonicalHash, type OimKnowledgePrincipalKind } from "@tulipfarm/schema";
import { readPointer } from "../egress/oim-pagination";
import type { KnowledgeProfilePlan } from "./oim-profile";
import type { EmittedPrincipalRef } from "./source";

export interface ListedItem {
  readonly itemId: string;
  readonly fields?: Readonly<Record<string, KnowledgeItemFieldValue>>;
  readonly revision?: string;
  readonly title?: string;
  readonly sourceUrl?: string;
  readonly updatedAt?: string;
  readonly contentType?: string;
  readonly deleted: boolean;
}

export type KnowledgeItemFieldValue = string | number | boolean;

export class OimKnowledgeMappingError extends Error {
  readonly name = "OimKnowledgeMappingError";

  constructor(readonly code: "item_field_invalid") {
    super(code);
  }
}

export interface MappedContent {
  readonly content: string;
  readonly contentType?: string;
  readonly revision?: string;
  readonly title?: string;
  readonly sourceUrl?: string;
  readonly updatedAt?: string;
}

export interface ProviderAclEntry {
  readonly kind: OimKnowledgePrincipalKind;
  /** Absent only for `public`, which names nobody in particular. */
  readonly id?: string;
}

export type AclUnverifiableReason =
  | "entries_absent"
  | "entries_not_array"
  | "no_entries"
  | "entry_kind_unknown"
  | "entry_identifier_absent";

export type AclReadResult =
  | { readonly status: "verified"; readonly entries: readonly ProviderAclEntry[] }
  | { readonly status: "unverifiable"; readonly reason: AclUnverifiableReason };

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Whether a provider is reporting an item as removed.
 *
 * Only values that unambiguously say so count. A provider that answers `"false"` or `0` is saying
 * the item is present, and reading either as truthy would delete live content out of the index.
 */
function deletedFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "1";
  if (typeof value === "number") return value === 1;
  return false;
}

function scalar(value: unknown): KnowledgeItemFieldValue | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/** Reads one page of the list operation. An item with no stable id is skipped, never guessed. */
export function mapListItems(
  plan: KnowledgeProfilePlan,
  response: unknown,
  scope?: string
): ListedItem[] {
  const raw = readPointer(response, plan.list.itemsPointer);
  if (!Array.isArray(raw)) return [];
  const mapping = plan.list.mapping;
  const items: ListedItem[] = [];
  for (const candidate of raw) {
    const fields: Record<string, KnowledgeItemFieldValue> = {};
    for (const [name, field] of Object.entries(mapping.itemFields ?? {})) {
      const value = scalar(
        field.source === "scope" ? scope : readPointer(candidate, field.pointer)
      );
      if (value === undefined) throw new OimKnowledgeMappingError("item_field_invalid");
      fields[name] = value;
    }
    const identity =
      mapping.itemIdentity === undefined
        ? undefined
        : mapping.itemIdentity.map((name) => {
            if (!Object.hasOwn(fields, name)) {
              throw new OimKnowledgeMappingError("item_field_invalid");
            }
            return [name, fields[name]] as const;
          });
    const itemId =
      identity === undefined
        ? mapping.itemId === undefined
          ? undefined
          : text(readPointer(candidate, mapping.itemId))
        : canonicalHash({ identity });
    if (itemId === undefined) continue;
    items.push({
      itemId,
      ...(mapping.itemFields === undefined ? {} : { fields }),
      revision: mapping.revision ? text(readPointer(candidate, mapping.revision)) : undefined,
      title: mapping.title ? text(readPointer(candidate, mapping.title)) : undefined,
      sourceUrl: mapping.sourceUrl ? text(readPointer(candidate, mapping.sourceUrl)) : undefined,
      updatedAt: mapping.updatedAt ? text(readPointer(candidate, mapping.updatedAt)) : undefined,
      contentType: mapping.contentType
        ? text(readPointer(candidate, mapping.contentType))
        : undefined,
      deleted: mapping.deleted ? deletedFlag(readPointer(candidate, mapping.deleted)) : false,
    });
  }
  return items;
}

/** Reads the content operation. `undefined` means the body was absent, which is not an empty body. */
export function mapContent(
  plan: KnowledgeProfilePlan,
  response: unknown
): MappedContent | undefined {
  const mapping = plan.content.mapping;
  const body = mapContentValue(response, mapping.content);
  if (body === undefined) return undefined;
  return {
    content: body,
    contentType: mapping.contentType ? text(readPointer(response, mapping.contentType)) : undefined,
    revision: mapping.revision ? text(readPointer(response, mapping.revision)) : undefined,
    title: mapping.title ? text(readPointer(response, mapping.title)) : undefined,
    sourceUrl: mapping.sourceUrl ? text(readPointer(response, mapping.sourceUrl)) : undefined,
    updatedAt: mapping.updatedAt ? text(readPointer(response, mapping.updatedAt)) : undefined,
  };
}

function mapContentValue(
  response: unknown,
  mapping: KnowledgeProfilePlan["content"]["mapping"]["content"]
): string | undefined {
  if (typeof mapping === "string") {
    const value = readPointer(response, mapping);
    return typeof value === "string" ? value : undefined;
  }

  const items = readPointer(response, mapping.itemsPointer);
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const values: string[] = [];
  for (const item of items) {
    const value = readPointer(item, mapping.itemPointer);
    if (typeof value !== "string") return undefined;
    values.push(value);
  }
  return values.join(mapping.separator);
}

/**
 * Reads the ACL operation into provider principals.
 *
 * An empty entry list is unverifiable rather than unrestricted. Providers use "no restrictions"
 * to mean "inherits from the container", and reading that as "everyone" is how an index publishes
 * a private document.
 */
export function mapAclEntries(plan: KnowledgeProfilePlan, response: unknown): AclReadResult {
  const raw = readPointer(response, plan.acl.entriesPointer);
  if (raw === undefined) return { status: "unverifiable", reason: "entries_absent" };
  if (!Array.isArray(raw)) return { status: "unverifiable", reason: "entries_not_array" };
  if (raw.length === 0) return { status: "unverifiable", reason: "no_entries" };

  const entry = plan.acl.entry;
  const entries: ProviderAclEntry[] = [];
  for (const candidate of raw) {
    const kind = entryKind(candidate, entry);
    if (kind === undefined) return { status: "unverifiable", reason: "entry_kind_unknown" };
    if (kind === "public") {
      entries.push({ kind });
      continue;
    }
    const pointer =
      kind === "user"
        ? entry.providerUserId
        : kind === "group"
          ? entry.providerGroupId
          : entry.domain;
    const id = pointer === undefined ? undefined : text(readPointer(candidate, pointer));
    if (id === undefined) return { status: "unverifiable", reason: "entry_identifier_absent" };
    entries.push({ kind, id });
  }
  return { status: "verified", entries };
}

function entryKind(
  candidate: unknown,
  entry: KnowledgeProfilePlan["acl"]["entry"]
): OimKnowledgePrincipalKind | undefined {
  if (entry.kindPointer === undefined) return entry.defaultKind;
  const value = text(readPointer(candidate, entry.kindPointer));
  if (value === undefined) return entry.defaultKind;
  for (const kind of ["user", "group", "domain", "public"] as const) {
    if (entry.kindValues?.[kind]?.includes(value)) return kind;
  }
  return undefined;
}

/** Looks a provider account up by the provider's own stable handle. */
export interface ProviderIdentityLinkPort {
  linkedPrincipal(input: {
    readonly businessId: string;
    readonly provider: string;
    readonly providerId: string;
  }): Promise<EmittedPrincipalRef | undefined>;
}

/** Looks a TulipFarm principal up by email, used only under an operator's domain policy. */
export interface VerifiedEmailPrincipalPort {
  principalForEmail(input: {
    readonly businessId: string;
    readonly email: string;
  }): Promise<EmittedPrincipalRef | undefined>;
}

/** Reads the provider's own record for one account, so an email can be checked for verification. */
export interface ProviderAccountPort {
  account(input: {
    readonly providerId: string;
  }): Promise<{ readonly email?: string; readonly emailVerified?: boolean } | undefined>;
  /** Provider user ids belonging to a group, or `undefined` when the membership is unreadable. */
  groupMembers(input: { readonly groupId: string }): Promise<readonly string[] | undefined>;
}

export interface KnowledgeIdentityPolicy {
  /**
   * Domains an operator has enabled for verified-email matching.
   *
   * Empty by default: an address the provider says is verified is still an address a stranger's
   * account may hold, so convenience has to be switched on per domain rather than assumed.
   */
  readonly verifiedEmailDomains: readonly string[];
}

export interface ResolveKnowledgePrincipalsDeps {
  readonly businessId: string;
  readonly provider: string;
  readonly links: ProviderIdentityLinkPort;
  readonly emails?: VerifiedEmailPrincipalPort;
  readonly accounts?: ProviderAccountPort;
  readonly policy: KnowledgeIdentityPolicy;
}

export interface ResolvedKnowledgeAcl {
  readonly principals: readonly EmittedPrincipalRef[];
  readonly domains: readonly string[];
  readonly public: boolean;
  /**
   * True when some grant could not be read at all — a group whose membership the provider refused.
   * The caller emits the source as unverifiable rather than with a quietly narrower ACL.
   */
  readonly incomplete: boolean;
}

/**
 * Turns provider ACL entries into TulipFarm principals.
 *
 * The stable provider link is the primary and only unconditional route. An email is a fallback
 * that needs the provider to call it verified *and* an operator to have enabled its domain, and a
 * display name is never consulted — it is chosen by the account it names, so matching on one lets
 * anyone who can rename themselves inherit somebody else's access.
 */
export async function resolveKnowledgePrincipals(
  entries: readonly ProviderAclEntry[],
  deps: ResolveKnowledgePrincipalsDeps
): Promise<ResolvedKnowledgeAcl> {
  const principals: EmittedPrincipalRef[] = [];
  const domains: string[] = [];
  const seen = new Set<string>();
  let isPublic = false;
  let incomplete = false;

  const addUser = async (providerId: string) => {
    const resolved = await resolveUser(providerId, deps);
    if (!resolved) return;
    const key = `${resolved.kind}:${resolved.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    principals.push(resolved);
  };

  for (const entry of entries) {
    if (entry.kind === "public") {
      isPublic = true;
      continue;
    }
    if (entry.id === undefined) continue;
    if (entry.kind === "domain") {
      const domain = entry.id.toLowerCase();
      if (!domains.includes(domain)) domains.push(domain);
      continue;
    }
    if (entry.kind === "user") {
      await addUser(entry.id);
      continue;
    }
    const members = await deps.accounts?.groupMembers({ groupId: entry.id });
    if (members === undefined) {
      incomplete = true;
      continue;
    }
    for (const member of members) await addUser(member);
  }

  return { principals, domains, public: isPublic, incomplete };
}

async function resolveUser(
  providerId: string,
  deps: ResolveKnowledgePrincipalsDeps
): Promise<EmittedPrincipalRef | undefined> {
  const linked = await deps.links.linkedPrincipal({
    businessId: deps.businessId,
    provider: deps.provider,
    providerId,
  });
  if (linked) return linked;

  if (deps.policy.verifiedEmailDomains.length === 0 || !deps.accounts || !deps.emails) {
    return undefined;
  }
  const account = await deps.accounts.account({ providerId });
  if (!account?.email || account.emailVerified !== true) return undefined;
  const domain = account.email.split("@")[1]?.toLowerCase();
  if (domain === undefined) return undefined;
  if (!deps.policy.verifiedEmailDomains.some((allowed) => allowed.toLowerCase() === domain)) {
    return undefined;
  }
  return await deps.emails.principalForEmail({
    businessId: deps.businessId,
    email: account.email.toLowerCase(),
  });
}
