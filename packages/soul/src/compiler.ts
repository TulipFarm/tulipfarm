import { createHash } from "node:crypto";
import {
  type ArtifactKind,
  artifactDirectory,
  artifactLayout,
  canonicalHash,
  classifySoulPath,
  isSecretReference,
  type VersionedSchemaDocument,
} from "@tulipfarm/schema";
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

/** Compile a validated Soul tree into an exact-version, secret-free runtime bundle. */

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

/** Secret refs must match the schema package shape or authoring and publication can diverge. */

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

/** Only the documented `secret://...` form is a reference. Everything else is a value. */
function isOpaqueReference(value: string): boolean {
  return isSecretReference(value);
}

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = 1024 * BYTES_PER_KIB;

// Companion files are authored prose, schemas, templates, and small hooks/scripts — not payloads.
export const MAX_BUNDLE_ASSET_BYTES = 2 * BYTES_PER_MIB;
// Risk scales with bytes stored in the signed jsonb bundle, not with authored file count. Mature
// Souls may have hundreds of small companions, so count must not brick publication; byte caps stop
// accidental vendored payloads while allowing broad but small authored trees.
export const MAX_BUNDLE_TOTAL_ASSET_BYTES = 16 * BYTES_PER_MIB;

function pointerSegment(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function secretIssue(subject: string, field: string): BundleError {
  return new BundleError(
    "SECRET_MATERIAL",
    `Execution bundle: ${subject} carries secret material at ${field}; Soul stores secret:// references only`,
    { subject, field }
  );
}

/**
 * Reject any secret value before it can reach a stored bundle. Only authored identifiers and JSON
 * pointers appear in the failure — never the offending value.
 */
function assertNoSecretMaterial(
  subject: string,
  value: unknown,
  field: string,
  requiresSecretReference = false
): void {
  if (typeof value === "string") {
    if (CREDENTIAL_MATERIAL.some((pattern) => pattern.test(value))) {
      throw secretIssue(subject, field);
    }
    if (requiresSecretReference && !isOpaqueReference(value)) {
      throw secretIssue(subject, field);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertNoSecretMaterial(subject, item, `${field}/${i}`, requiresSecretReference);
    });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childField = `${field}/${pointerSegment(key)}`;
    assertNoSecretMaterial(subject, child, childField, SECRET_BEARING_KEY.test(key));
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MIB) return `${Number((bytes / BYTES_PER_MIB).toFixed(2))} MiB`;
  if (bytes >= BYTES_PER_KIB) return `${Number((bytes / BYTES_PER_KIB).toFixed(2))} KiB`;
  return `${bytes} bytes`;
}

function assetIssue(subject: string, field: string, message: string): BundleError {
  return new BundleError("INVALID_DEFINITION", message, { subject, field });
}

function assertTextAsset(
  subject: string,
  field: string,
  sourcePath: string,
  content: string
): void {
  // NUL is rejected because PostgreSQL genuinely cannot store it in text/jsonb — the write would
  // fail anyway, so failing here is the honest, earlier error. Nothing else is rejected on
  // aesthetic grounds: every publication recompiles the whole tree, so any content rule that
  // refuses legitimate authored prose freezes ALL Soul publication for that business, forever and
  // silently. U+FFFD in particular is valid UTF-8, stores fine, and is a routine artifact of
  // pasting from a mis-encoded source — it must not be able to wedge the business.
  if (content.includes("\u0000")) {
    throw assetIssue(
      subject,
      field,
      `Execution bundle: ${sourcePath} contains NUL bytes; Soul bundle assets must be UTF-8 text safe for jsonb storage`
    );
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

function hasEnabledHooks(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).enabled === true
  );
}

function declaredAssetPaths(definition: AuthoredDefinition): string[] {
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
  const layout = artifactLayout(definition.kind as ArtifactKind);
  if (
    layout?.companions.some((companion) => companion.match === "hooks.ts") &&
    hasEnabledHooks(definition.spec.hooks)
  ) {
    paths.add("hooks.ts");
  }
  return [...paths].sort();
}

function sourceFileAssetPath(
  filePath: string,
  definitionIdsBySubject: ReadonlyMap<string, string>
): { ownerDefinitionId: string; path: string } {
  const location = classifySoulPath(filePath);
  if (location?.layout.scope === "collection" && location.slug !== null) {
    const prefix = `${artifactDirectory(location.layout.kind, location.slug)}/`;
    const subject = `${location.kind}:${location.slug}`;
    return {
      // If the owning definition is present, undeclared swept companions use the same stable
      // metadata id as declared companions. If not, delegated source files keep a path-derived
      // owner so operators can still identify and remove the offending tree path.
      ownerDefinitionId: definitionIdsBySubject.get(subject) ?? subject,
      path: filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath,
    };
  }
  return { ownerDefinitionId: location?.kind ?? "Soul", path: filePath };
}

function appendAsset(
  assets: BundleAsset[],
  candidate: {
    readonly ownerDefinitionId: string;
    readonly subject: string;
    readonly path: string;
    readonly sourcePath: string;
    readonly content: string;
  },
  totalAssetBytes: number
): number {
  const field = `/assets/${candidate.path}`;
  assertTextAsset(candidate.subject, field, candidate.sourcePath, candidate.content);
  const assetBytes = Buffer.byteLength(candidate.content, "utf8");
  if (assetBytes > MAX_BUNDLE_ASSET_BYTES) {
    throw assetIssue(
      candidate.subject,
      field,
      `Execution bundle: remove or shrink ${candidate.sourcePath}; it is ${formatBytes(assetBytes)}, exceeding the ${formatBytes(MAX_BUNDLE_ASSET_BYTES)} per-asset limit`
    );
  }
  const nextTotal = totalAssetBytes + assetBytes;
  if (nextTotal > MAX_BUNDLE_TOTAL_ASSET_BYTES) {
    throw assetIssue(
      candidate.subject,
      field,
      `Execution bundle: remove or shrink ${candidate.sourcePath} or another bundled asset; this file brings bundled assets to ${formatBytes(nextTotal)}, exceeding the ${formatBytes(MAX_BUNDLE_TOTAL_ASSET_BYTES)} total asset limit`
    );
  }
  assertNoSecretMaterial(candidate.subject, candidate.content, field);
  assets.push(
    Object.freeze({
      ownerDefinitionId: candidate.ownerDefinitionId,
      path: candidate.path,
      digest: createHash("sha256").update(candidate.content, "utf8").digest("hex"),
      content: candidate.content,
    })
  );
  return nextTotal;
}

function compileAssets(
  definitions: readonly AuthoredDefinition[],
  files: readonly BundleSourceFile[] | undefined
): readonly BundleAsset[] {
  if (files === undefined) return Object.freeze([]);
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const assets: BundleAsset[] = [];
  const consumed = new Set<string>();
  const definitionIdsBySubject = new Map(
    definitions.map((definition) => [definition.subject, definition.id])
  );
  let totalAssetBytes = 0;
  for (const definition of definitions) {
    const layout = artifactLayout(definition.kind as ArtifactKind);
    if (layout?.scope !== "collection" || layout.companions.length === 0) continue;
    const ownerDirectory = artifactDirectory(layout.kind, definition.slug);
    for (const path of declaredAssetPaths(definition)) {
      const fullPath = `${ownerDirectory}/${path}`;
      const content = byPath.get(fullPath);
      if (content === undefined) {
        throw new BundleError(
          "INVALID_DEFINITION",
          `Execution bundle: ${definition.subject} is missing declared companion file ${path}`,
          { subject: definition.subject, field: "/spec" }
        );
      }
      consumed.add(fullPath);
      totalAssetBytes = appendAsset(
        assets,
        {
          ownerDefinitionId: definition.id,
          subject: definition.subject,
          path,
          sourcePath: fullPath,
          content,
        },
        totalAssetBytes
      );
    }
  }
  for (const file of files) {
    if (consumed.has(file.path)) continue;
    const { ownerDefinitionId, path } = sourceFileAssetPath(file.path, definitionIdsBySubject);
    totalAssetBytes = appendAsset(
      assets,
      {
        ownerDefinitionId,
        subject: ownerDefinitionId,
        path,
        sourcePath: file.path,
        content: file.content,
      },
      totalAssetBytes
    );
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
