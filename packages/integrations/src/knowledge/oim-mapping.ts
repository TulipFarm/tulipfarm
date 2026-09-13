import { canonicalHash, type OimKnowledgePrincipalKind } from "@tulipfarm/schema";
import { readPointer } from "../egress/oim-pagination";
import type { KnowledgeProfilePlan } from "./oim-profile";

export type KnowledgeItemFieldValue = string | number | boolean;

export interface ListedItem {
  readonly itemId: string;
  readonly fields?: Readonly<Record<string, KnowledgeItemFieldValue>>;
  readonly revision?: string;
  readonly sourceUrl?: string;
  readonly deleted: boolean;
}

export class OimKnowledgeMappingError extends Error {
  readonly name = "OimKnowledgeMappingError";

  constructor(readonly code: "item_field_invalid" | "list_items_invalid") {
    super(code);
  }
}

export interface MappedContent {
  readonly content: string;
  readonly revision?: string;
  readonly sourceUrl?: string;
}

export interface ProviderAclEntry {
  readonly kind: OimKnowledgePrincipalKind;
  readonly id?: string;
}

export type AclReadResult =
  | { readonly status: "verified"; readonly entries: readonly ProviderAclEntry[] }
  | { readonly status: "unverifiable" };

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function scalar(value: unknown): KnowledgeItemFieldValue | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function mapListItems(
  plan: KnowledgeProfilePlan,
  response: unknown,
  scope?: string
): ListedItem[] {
  const raw = readPointer(response, plan.list.itemsPointer);
  if (!Array.isArray(raw)) throw new OimKnowledgeMappingError("list_items_invalid");
  const mapping = plan.list.mapping;
  return raw.flatMap((candidate) => {
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
    if (itemId === undefined) throw new OimKnowledgeMappingError("item_field_invalid");
    const deleted = mapping.deleted === undefined ? false : readPointer(candidate, mapping.deleted);
    return [
      {
        itemId,
        ...(mapping.itemFields === undefined ? {} : { fields }),
        ...(mapping.revision === undefined
          ? {}
          : { revision: text(readPointer(candidate, mapping.revision)) }),
        ...(mapping.sourceUrl === undefined
          ? {}
          : { sourceUrl: text(readPointer(candidate, mapping.sourceUrl)) }),
        deleted: deleted === true || deleted === 1 || deleted === "1" || deleted === "true",
      },
    ];
  });
}

export function mapContent(
  plan: KnowledgeProfilePlan,
  response: unknown
): MappedContent | undefined {
  const mapping = plan.content.mapping;
  const content =
    typeof mapping.content === "string"
      ? readPointer(response, mapping.content)
      : joinContent(response, mapping.content);
  if (typeof content !== "string") return undefined;
  return {
    content,
    ...(mapping.revision === undefined
      ? {}
      : { revision: text(readPointer(response, mapping.revision)) }),
    ...(mapping.sourceUrl === undefined
      ? {}
      : { sourceUrl: text(readPointer(response, mapping.sourceUrl)) }),
  };
}

function joinContent(
  response: unknown,
  mapping: Exclude<KnowledgeProfilePlan["content"]["mapping"]["content"], string>
): string | undefined {
  const items = readPointer(response, mapping.itemsPointer);
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const values = items.map((item) => readPointer(item, mapping.itemPointer));
  return values.every((value): value is string => typeof value === "string")
    ? values.join(mapping.separator)
    : undefined;
}

export function mapAclEntries(plan: KnowledgeProfilePlan, response: unknown): AclReadResult {
  const raw = readPointer(response, plan.acl.entriesPointer);
  if (!Array.isArray(raw) || raw.length === 0) return { status: "unverifiable" };
  const entries: ProviderAclEntry[] = [];
  for (const candidate of raw) {
    const kind = entryKind(candidate, plan.acl.entry);
    if (kind === undefined) return { status: "unverifiable" };
    if (kind === "public") {
      entries.push({ kind });
      continue;
    }
    const pointer =
      kind === "user"
        ? plan.acl.entry.providerUserId
        : kind === "group"
          ? plan.acl.entry.providerGroupId
          : plan.acl.entry.domain;
    const id = pointer === undefined ? undefined : text(readPointer(candidate, pointer));
    if (id === undefined) return { status: "unverifiable" };
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
