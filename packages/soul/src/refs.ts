import type { VersionedSchemaDocument } from "@tulipfarm/schema";

/** Semantic reference validation over the proposed Soul tree; issues carry no content or secrets. */

export type SoulSemanticIssueCode =
  | "DUPLICATE_ID"
  | "DUPLICATE_SLUG"
  | "UNRESOLVED_REF"
  | "VERSION_UNSATISFIED"
  | "ROUTINE_START_UNKNOWN"
  | "ROUTINE_TRANSITION_UNKNOWN"
  | "ROUTINE_DUPLICATE_STATE"
  | "TRIGGER_NAME_CONFLICT"
  | "SKILL_DUPLICATE_COMMAND"
  | "SKILL_ENTRYPOINT_UNDECLARED"
  | "SKILL_TOOL_ADAPTER_INVALID"
  | "SKILL_TOOL_BINDING_INVALID"
  | "INHERITANCE_CYCLE"
  | "FALLBACK_CYCLE"
  | "RISK_EXCEEDS_CEILING"
  | "DESTINATION_NOT_GRANTED";

export interface SoulSemanticIssue {
  readonly code: SoulSemanticIssueCode;
  /** The owning definition, as `Kind:slug` (payload-safe authored identity). */
  readonly subject: string;
  /** The offending reference, state name, or identifier (payload-safe). */
  readonly ref?: string;
  /** JSON pointer into the owning definition's document. */
  readonly field?: string;
}

/** A deterministic, payload-safe semantic rejection suitable for gateway boundary evidence. */
export class SoulSemanticValidationError extends Error {
  readonly issues: readonly SoulSemanticIssue[];

  constructor(issues: readonly SoulSemanticIssue[]) {
    super(
      `Soul semantic validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"})`
    );
    this.name = "SoulSemanticValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export function sortIssues(issues: readonly SoulSemanticIssue[]): SoulSemanticIssue[] {
  const key = (i: SoulSemanticIssue) =>
    `${i.subject}\u0000${i.code}\u0000${i.field ?? ""}\u0000${i.ref ?? ""}`;
  return [...issues].sort((left, right) => {
    const l = key(left);
    const r = key(right);
    if (l < r) return -1;
    if (l > r) return 1;
    return 0;
  });
}

// ── Narrowed view of an authored definition ─────────────────────────────────────

export interface AuthoredDefinition {
  readonly kind: string;
  readonly id: string;
  readonly slug: string;
  readonly authoredVersion: number;
  readonly spec: Record<string, unknown>;
  /** `Kind:slug`, the payload-safe subject used in issues. */
  readonly subject: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow validated documents to semantic fields; skip impossible malformed shapes. */
export function asAuthored(doc: VersionedSchemaDocument): AuthoredDefinition | undefined {
  const kind = doc.kind;
  const metadata = (doc as Record<string, unknown>).metadata;
  const spec = (doc as Record<string, unknown>).spec;
  if (typeof kind !== "string" || !isRecord(metadata) || !isRecord(spec)) return undefined;
  const { id, slug, authoredVersion } = metadata;
  if (typeof id !== "string" || typeof slug !== "string" || typeof authoredVersion !== "number") {
    return undefined;
  }
  return { kind, id, slug, authoredVersion, spec, subject: `${kind}:${slug}` };
}

// ── Index over the proposed tree ────────────────────────────────────────────────

export class DefinitionIndex {
  private readonly byId = new Map<string, AuthoredDefinition>();
  private readonly byKindSlug = new Map<string, AuthoredDefinition[]>();
  readonly all: readonly AuthoredDefinition[];

  private constructor(defs: readonly AuthoredDefinition[]) {
    this.all = defs;
    for (const def of defs) {
      this.byId.set(def.id, def);
      const key = `${def.kind}\u0000${def.slug}`;
      const bucket = this.byKindSlug.get(key);
      if (bucket) bucket.push(def);
      else this.byKindSlug.set(key, [def]);
    }
  }

  /** Build the index and report duplicate stable identifiers found while building it. */
  static build(docs: readonly VersionedSchemaDocument[]): {
    index: DefinitionIndex;
    issues: SoulSemanticIssue[];
  } {
    const defs: AuthoredDefinition[] = [];
    const issues: SoulSemanticIssue[] = [];
    const seenId = new Set<string>();
    const seenKindSlug = new Set<string>();
    for (const doc of docs) {
      const def = asAuthored(doc);
      if (!def) continue;
      if (seenId.has(def.id)) {
        issues.push({
          code: "DUPLICATE_ID",
          subject: def.subject,
          ref: def.id,
          field: "/metadata/id",
        });
      } else {
        seenId.add(def.id);
      }
      const kindSlug = `${def.kind}\u0000${def.slug}`;
      if (seenKindSlug.has(kindSlug)) {
        issues.push({
          code: "DUPLICATE_SLUG",
          subject: def.subject,
          ref: def.slug,
          field: "/metadata/slug",
        });
      } else {
        seenKindSlug.add(kindSlug);
      }
      defs.push(def);
    }
    return { index: new DefinitionIndex(defs), issues };
  }

  ofKind(kind: string): AuthoredDefinition[] {
    return this.all.filter((d) => d.kind === kind);
  }

  /** A plain reference (slug or id) resolves when a definition of `kind` matches either. */
  resolves(ref: string, kind: string): boolean {
    const byId = this.byId.get(ref);
    if (byId?.kind === kind) return true;
    return (this.byKindSlug.get(`${kind}\u0000${ref}`)?.length ?? 0) > 0;
  }

  candidates(slug: string, kind: string): AuthoredDefinition[] {
    return this.byKindSlug.get(`${kind}\u0000${slug}`) ?? [];
  }

  get(id: string): AuthoredDefinition | undefined {
    return this.byId.get(id);
  }
}

// ── Reference resolution (SPEC §8.2 step 7) ─────────────────────────────────────

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export interface DefinitionRef {
  readonly id?: string;
  readonly name: string;
  readonly version: string;
}

export function asDefinitionRef(value: unknown): DefinitionRef | undefined {
  if (!isRecord(value)) return undefined;
  const { name, version, id } = value;
  if (typeof name !== "string" || typeof version !== "string") return undefined;
  return { name, version, id: typeof id === "string" ? id : undefined };
}

function versionSatisfied(candidates: AuthoredDefinition[], version: string): boolean {
  if (version === "*" || version === "latest") return candidates.length > 0;
  return candidates.some((c) => String(c.authoredVersion) === version);
}

/** Resolve a `{ name, version }` reference and its version constraint against the tree. */
function resolveVersionedRef(
  index: DefinitionIndex,
  def: AuthoredDefinition,
  value: unknown,
  kind: string,
  field: string
): SoulSemanticIssue[] {
  const ref = asDefinitionRef(value);
  if (!ref) return [];
  if (ref.id) {
    const byId = index.get(ref.id);
    if (byId?.kind !== kind) {
      return [{ code: "UNRESOLVED_REF", subject: def.subject, ref: ref.id, field: `${field}/id` }];
    }
    return [];
  }
  const candidates = index.candidates(ref.name, kind);
  if (candidates.length === 0) {
    return [
      { code: "UNRESOLVED_REF", subject: def.subject, ref: ref.name, field: `${field}/name` },
    ];
  }
  if (!versionSatisfied(candidates, ref.version)) {
    return [
      {
        code: "VERSION_UNSATISFIED",
        subject: def.subject,
        ref: ref.version,
        field: `${field}/version`,
      },
    ];
  }
  return [];
}

/** Field name → target kind, for an Agent's plain (slug/id) refList edges. */
const AGENT_REF_EDGES: ReadonlyArray<readonly [string, string]> = [
  ["roles", "Role"],
  ["skills", "Skill"],
  ["allowedTools", "ToolContract"],
  ["knowledgeScopes", "KnowledgeSource"],
];

/** Field name → target kind, for the single-field plain refList edges of other kinds. */
const PLAIN_REF_EDGES: ReadonlyArray<readonly [string, string, string]> = [
  ["Role", "inherits", "Role"],
  ["ModelProfile", "fallbacks", "ModelProfile"],
  ["Skill", "dependencies", "Skill"],
];

/** Routine State type → the versioned ref field it carries and that field's target kind. */
export const ROUTINE_STATE_REF_EDGES: Record<string, readonly [string, string]> = {
  agent: ["agentRef", "Agent"],
  tool: ["toolRef", "ToolContract"],
  form: ["formRef", "Form"],
  child_routine: ["routineRef", "Routine"],
};

/**
 * One authored reference edge out of a definition. `plain` edges carry a slug-or-id string;
 * `versioned` edges carry a `{ name, version, id? }` record.
 */
export interface ReferenceEdge {
  /** Target definition kind. */
  readonly kind: string;
  /** JSON pointer of the reference inside the owning definition. */
  readonly field: string;
  readonly value: unknown;
  readonly form: "plain" | "versioned";
}

function plainEdges(refs: string[], kind: string, field: string): ReferenceEdge[] {
  return refs.map((value, i) => ({ kind, field: `${field}/${i}`, value, form: "plain" as const }));
}

/**
 * The complete reference topology of a definition — the single owner of which authored fields are
 * references. Both semantic validation and bundle compilation read it, so the two can never drift.
 */
export function collectReferenceEdges(def: AuthoredDefinition): ReferenceEdge[] {
  const edges: ReferenceEdge[] = [];
  if (def.kind === "Agent") {
    for (const [field, kind] of AGENT_REF_EDGES) {
      edges.push(...plainEdges(stringList(def.spec[field]), kind, `/spec/${field}`));
    }
    if (typeof def.spec.modelProfile === "string") {
      edges.push({
        kind: "ModelProfile",
        field: "/spec/modelProfile",
        value: def.spec.modelProfile,
        form: "plain",
      });
    }
    const ceiling = def.spec.permissionCeiling;
    if (isRecord(ceiling)) {
      edges.push(
        ...plainEdges(stringList(ceiling.grants), "Role", "/spec/permissionCeiling/grants")
      );
    }
  }

  for (const [kind, field, target] of PLAIN_REF_EDGES) {
    if (def.kind === kind) {
      edges.push(...plainEdges(stringList(def.spec[field]), target, `/spec/${field}`));
    }
  }

  if (def.kind === "Skill") {
    const commands = Array.isArray(def.spec.commands) ? def.spec.commands : [];
    commands.forEach((command, index) => {
      if (isRecord(command) && typeof command.toolRef === "string") {
        edges.push({
          kind: "ToolContract",
          field: `/spec/commands/${index}/toolRef`,
          value: command.toolRef,
          form: "plain",
        });
      }
    });
  }

  if (def.kind === "Routine") {
    const states = Array.isArray(def.spec.states) ? def.spec.states : [];
    states.forEach((state, i) => {
      if (!isRecord(state) || typeof state.type !== "string") return;
      const edge = ROUTINE_STATE_REF_EDGES[state.type];
      if (!edge) return;
      const [field, kind] = edge;
      edges.push({
        kind,
        field: `/spec/states/${i}/${field}`,
        value: state[field],
        form: "versioned",
      });
    });
  }

  return edges;
}

export function resolveReferences(index: DefinitionIndex): SoulSemanticIssue[] {
  const issues: SoulSemanticIssue[] = [];
  for (const def of index.all) {
    for (const edge of collectReferenceEdges(def)) {
      if (edge.form === "plain") {
        if (typeof edge.value === "string" && !index.resolves(edge.value, edge.kind)) {
          issues.push({
            code: "UNRESOLVED_REF",
            subject: def.subject,
            ref: edge.value,
            field: edge.field,
          });
        }
        continue;
      }
      issues.push(...resolveVersionedRef(index, def, edge.value, edge.kind, edge.field));
    }
  }
  return issues;
}
