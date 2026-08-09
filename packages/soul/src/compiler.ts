import { createHash } from "node:crypto";
import { canonicalHash, type VersionedSchemaDocument } from "@tulipfarm/schema";
import {
  type BundleAsset,
  type BundleDefinition,
  BundleError,
  EXECUTION_BUNDLE_VERSION,
  type ExecutionBundle,
  immutableSnapshot,
  type ResolvedReference,
} from "./bundle";
import {
  type AuthoredDefinition,
  asAuthored,
  asDefinitionRef,
  collectReferenceEdges,
  DefinitionIndex,
  type ReferenceEdge,
} from "./refs";

/**
 * Bundle compilation (SPEC §8.2 step 9): resolve every reference to an exact authored version,
 * canonicalize, and hash the complete immutable runtime bundle.
 *
 * Compilation runs after strict AJV validation and semantic validation, and
 * before signing. It is synchronous, side-effect free, and fail-closed: a reference that does not
 * resolve, a version constraint the tree cannot satisfy, or any secret value found in the tree
 * rejects the whole bundle rather than compiling a partial one.
 */

export interface BundleCompileRequest {
  readonly businessId: string;
  readonly changesetId: string;
  /** The signed Soul commit the proposed tree was written as. */
  readonly commitSha: string;
  /** The validated authored definitions of the tree being published. */
  readonly documents: readonly VersionedSchemaDocument[];
  /** Exact UTF-8 companion files read from the same committed tree as `documents`. */
  readonly files?: readonly BundleSourceFile[];
}

export interface BundleSourceFile {
  readonly path: string;
  readonly content: string;
}

// ── Secret exclusion (SPEC §8.1: Soul stores only opaque secret identifiers) ─────

/** Authored field names that may only ever carry an opaque reference, never a value. */
const SECRET_BEARING_KEY = /(secret|password|passwd|token|credential|api[-_]?key|private[-_]?key)/i;

/** Shapes that are credential material regardless of the field they appear under. */
const CREDENTIAL_MATERIAL: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/** An opaque reference has no whitespace and is short — anything else is a value, not a pointer. */
function isOpaqueReference(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\s/.test(value);
}

function pointerSegment(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function secretIssue(subject: string, field: string): BundleError {
  return new BundleError(
    "SECRET_MATERIAL",
    `Execution bundle: ${subject} carries secret material at ${field}; Soul stores opaque secret references only`,
    { subject, field }
  );
}

/**
 * Reject any secret value before it can reach a stored bundle. Only authored identifiers and JSON
 * pointers appear in the failure — never the offending value.
 */
function assertNoSecretMaterial(subject: string, value: unknown, field: string): void {
  if (typeof value === "string") {
    if (CREDENTIAL_MATERIAL.some((pattern) => pattern.test(value))) {
      throw secretIssue(subject, field);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertNoSecretMaterial(subject, item, `${field}/${i}`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childField = `${field}/${pointerSegment(key)}`;
    if (SECRET_BEARING_KEY.test(key) && typeof child === "string" && !isOpaqueReference(child)) {
      throw secretIssue(subject, childField);
    }
    assertNoSecretMaterial(subject, child, childField);
  }
}

// ── Exact-version resolution (SPEC §8.1: publication resolves references to exact versions) ──

/** The authored version a reference pins to: the highest version of the matching definition. */
function pinned(candidates: readonly AuthoredDefinition[]): AuthoredDefinition | undefined {
  return candidates.reduce<AuthoredDefinition | undefined>(
    (best, candidate) =>
      best === undefined || candidate.authoredVersion > best.authoredVersion ? candidate : best,
    undefined
  );
}

function toResolved(field: string, target: AuthoredDefinition): ResolvedReference {
  return Object.freeze({
    field,
    kind: target.kind,
    id: target.id,
    slug: target.slug,
    authoredVersion: target.authoredVersion,
  });
}

function unresolved(def: AuthoredDefinition, field: string): BundleError {
  return new BundleError(
    "UNRESOLVED_REF",
    `Execution bundle: ${def.subject} references a definition that is not in the published tree`,
    { subject: def.subject, field }
  );
}

function resolveEdge(
  index: DefinitionIndex,
  def: AuthoredDefinition,
  edge: ReferenceEdge
): ResolvedReference | undefined {
  if (edge.form === "plain") {
    if (typeof edge.value !== "string") return undefined;
    const byId = index.get(edge.value);
    const target =
      byId?.kind === edge.kind ? byId : pinned(index.candidates(edge.value, edge.kind));
    if (!target) throw unresolved(def, edge.field);
    return toResolved(edge.field, target);
  }

  const ref = asDefinitionRef(edge.value);
  if (!ref) return undefined;
  if (ref.id !== undefined) {
    const byId = index.get(ref.id);
    if (byId?.kind !== edge.kind) throw unresolved(def, `${edge.field}/id`);
    if (
      ref.version !== "*" &&
      ref.version !== "latest" &&
      String(byId.authoredVersion) !== ref.version
    ) {
      throw new BundleError(
        "VERSION_UNSATISFIED",
        `Execution bundle: ${def.subject} requests a version the published tree does not contain`,
        { subject: def.subject, field: `${edge.field}/version` }
      );
    }
    return toResolved(edge.field, byId);
  }

  const candidates = index.candidates(ref.name, edge.kind);
  if (candidates.length === 0) throw unresolved(def, `${edge.field}/name`);
  const exact =
    ref.version === "*" || ref.version === "latest"
      ? pinned(candidates)
      : candidates.find((candidate) => String(candidate.authoredVersion) === ref.version);
  if (!exact) {
    throw new BundleError(
      "VERSION_UNSATISFIED",
      `Execution bundle: ${def.subject} requests a version the published tree does not contain`,
      { subject: def.subject, field: `${edge.field}/version` }
    );
  }
  return toResolved(edge.field, exact);
}

function compileDefinition(
  index: DefinitionIndex,
  def: AuthoredDefinition,
  document: VersionedSchemaDocument
): BundleDefinition {
  assertNoSecretMaterial(def.subject, document, "");
  const references: ResolvedReference[] = [];
  for (const edge of collectReferenceEdges(def)) {
    const resolved = resolveEdge(index, def, edge);
    if (resolved) references.push(resolved);
  }
  const immutableDocument = immutableSnapshot(document);
  return Object.freeze({
    kind: def.kind,
    id: def.id,
    slug: def.slug,
    authoredVersion: def.authoredVersion,
    hash: canonicalHash(immutableDocument),
    document: immutableDocument,
    references: Object.freeze(references),
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function skillAssetPaths(definition: AuthoredDefinition): string[] {
  const paths = new Set<string>();
  const instructions = definition.spec.instructions;
  if (
    typeof instructions === "object" &&
    instructions !== null &&
    !Array.isArray(instructions) &&
    typeof (instructions as Record<string, unknown>).path === "string"
  ) {
    paths.add((instructions as Record<string, unknown>).path as string);
  }
  for (const field of ["references", "templates", "examples", "schemas", "assets", "scripts"]) {
    for (const path of stringList(definition.spec[field])) paths.add(path);
  }
  return [...paths].sort();
}

function compileAssets(
  definitions: readonly AuthoredDefinition[],
  files: readonly BundleSourceFile[] | undefined
): readonly BundleAsset[] {
  if (files === undefined) return Object.freeze([]);
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const assets: BundleAsset[] = [];
  for (const definition of definitions.filter((candidate) => candidate.kind === "Skill")) {
    for (const path of skillAssetPaths(definition)) {
      const fullPath = `skills/${definition.slug}/${path}`;
      const content = byPath.get(fullPath);
      if (content === undefined) {
        throw new BundleError(
          "INVALID_DEFINITION",
          `Execution bundle: ${definition.subject} is missing declared companion file ${path}`,
          { subject: definition.subject, field: "/spec" }
        );
      }
      assertNoSecretMaterial(definition.subject, content, `/assets/${path}`);
      assets.push(
        Object.freeze({
          ownerDefinitionId: definition.id,
          path,
          digest: createHash("sha256").update(content, "utf8").digest("hex"),
          content,
        })
      );
    }
  }
  assets.sort((left, right) => {
    const owner = left.ownerDefinitionId.localeCompare(right.ownerDefinitionId);
    return owner === 0 ? left.path.localeCompare(right.path) : owner;
  });
  return Object.freeze(assets);
}

/**
 * Compile the immutable execution bundle for a published tree. Throws {@link BundleError} — always
 * payload-safe — on the first deterministic failure; nothing partial is ever returned.
 */
export function compileExecutionBundle(request: BundleCompileRequest): ExecutionBundle {
  const authored = request.documents.map((document) => {
    const def = asAuthored(document);
    if (!def) {
      throw new BundleError(
        "INVALID_DEFINITION",
        `Execution bundle: a ${document.kind} document is missing stable authored identity`
      );
    }
    return { def, document };
  });

  const { index } = DefinitionIndex.build(request.documents);
  const definitions = authored
    .map(({ def, document }) => compileDefinition(index, def, document))
    .sort((left, right) =>
      left.kind === right.kind
        ? left.slug.localeCompare(right.slug)
        : left.kind.localeCompare(right.kind)
    );
  const assets = compileAssets(
    authored.map(({ def }) => def),
    request.files
  );

  return Object.freeze({
    bundleVersion: EXECUTION_BUNDLE_VERSION,
    businessId: request.businessId,
    changesetId: request.changesetId,
    commitSha: request.commitSha,
    definitions: Object.freeze(definitions),
    assets,
  });
}
