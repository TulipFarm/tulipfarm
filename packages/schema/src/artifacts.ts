import { DEFINITION_KINDS, type DefinitionKind } from "./definitions/index";

/**
 * The authored Soul tree's layout, declared once.
 *
 * Before this table, three separate places knew where artifacts live: the changeset validator, the
 * loader, and every writer that composed a path by hand. They drifted — the validator was written
 * against a layout the runtime never adopted, so it rejected almost every real file and was
 * therefore never wired in. Layout is data now, so a path can be classified, built, and validated
 * from one declaration and the three consumers cannot disagree.
 *
 * Adding an artifact kind is an entry here, not a code change in three packages.
 */

/**
 * Non-definition artifacts the tree also carries. These are governed files with an owner other
 * than the definition registry: a policy validated by its own function, or machine-written state.
 */
export const DELEGATED_ARTIFACT_KINDS = [
  "SurfaceComponent",
  "GuardrailsPolicy",
  "ObservabilityConfig",
  "SkillsLock",
  "IntegrationsLock",
] as const;
export type DelegatedArtifactKind = (typeof DELEGATED_ARTIFACT_KINDS)[number];

export type ArtifactKind = DefinitionKind | DelegatedArtifactKind;

/**
 * Temporal semantics for Soul artifacts.
 *
 * ADR-008 makes bundles immutable so behaviour stays frozen for a Run, but
 * `docs/architecture/authorization-design.md` Invariant 2 forbids doing that to authority:
 * authorization is evaluated live, never from a Run-pinned copy. Otherwise a parked Run could keep
 * using a Role or AccessGrant after an administrator revoked it.
 *
 * - `pinned` — behaviour/configuration read from the Run's bundle digest.
 * - `live` — authority read from the current active version, so revocation reaches in-flight Runs.
 */
export const TEMPORAL_CLASSES = ["pinned", "live"] as const;
export type TemporalClass = (typeof TEMPORAL_CLASSES)[number];

/**
 * How a file's *content* may be checked. A path can admit more than one mode: during the migration
 * to the `apiVersion`/`kind` envelope, `routines/<slug>/routine.yaml` legitimately holds either
 * format, and `skills/<slug>/SKILL.md` is either a legacy definition (it has frontmatter) or plain
 * prose (it does not). Encoding that honestly is what lets one gate serve both layouts.
 *
 * - `definition` — strict `apiVersion`/`kind` validation through the schema registry.
 * - `legacy` — the superseded pre-envelope format; accepted, but reported for migration.
 * - `delegated` — validated by the package that owns the shape (e.g. Surface components).
 * - `prose` — free text. Content-addressed, never schema-checked.
 * - `executable` — code. Content-addressed and subject to trust review, never "validated" as
 *   configuration; a schema cannot tell you what a program does.
 * - `managed` — machine-written state (lock files, connection records). Not authored by hand.
 */
export const CONTENT_MODES = [
  "definition",
  "legacy",
  "delegated",
  "prose",
  "executable",
  "managed",
] as const;
export type ContentMode = (typeof CONTENT_MODES)[number];

/**
 * A file that may sit beside a definition. `match` is an exact filename (`instructions.md`), a
 * directory prefix (`assets/`), or an extension glob (`*.ts`).
 */
export interface ArtifactCompanion {
  readonly match: string;
  readonly modes: readonly ContentMode[];
}

export interface ArtifactLayout {
  readonly kind: ArtifactKind;
  readonly temporalClass: TemporalClass;
  /** `singleton` lives at the tree root; `collection` lives under `<directory>/<slug>/`. */
  readonly scope: "collection" | "singleton";
  /** Empty for singletons. */
  readonly directory: string;
  /** The canonical file carrying this artifact's configuration. */
  readonly definitionFile: string;
  /** Content modes the canonical file admits, canonical form first. */
  readonly definitionModes: readonly ContentMode[];
  /** Superseded filenames that still carry configuration. Migration renames these away. */
  readonly legacyDefinitionFiles: readonly string[];
  readonly companions: readonly ArtifactCompanion[];
}

const HOOKS: ArtifactCompanion = { match: "hooks.ts", modes: ["executable"] };

/**
 * Collections use one uniform shape — `<directory>/<slug>/<definitionFile>` — with no flat-file
 * exceptions. Uniformity is the point: the gateway, the loader, and the writers need no per-kind
 * path branching, and an artifact that later grows a companion does not force a layout migration.
 */
const ARTIFACT_LAYOUT_ENTRIES = [
  {
    kind: "Settings",
    temporalClass: "pinned",
    scope: "singleton",
    directory: "",
    definitionFile: "soul.yaml",
    definitionModes: ["definition", "legacy"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "GuardrailsPolicy",
    temporalClass: "pinned",
    scope: "singleton",
    directory: "",
    definitionFile: "guardrails.yaml",
    definitionModes: ["delegated"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "ObservabilityConfig",
    temporalClass: "pinned",
    scope: "singleton",
    directory: "",
    definitionFile: "observability.config.yaml",
    definitionModes: ["delegated"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "SkillsLock",
    temporalClass: "pinned",
    scope: "singleton",
    directory: "",
    definitionFile: "skills-lock.json",
    definitionModes: ["managed"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "IntegrationsLock",
    temporalClass: "pinned",
    scope: "singleton",
    directory: "",
    definitionFile: "integrations-lock.json",
    definitionModes: ["managed"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "Agent",
    temporalClass: "pinned",
    scope: "collection",
    directory: "agents",
    definitionFile: "agent.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: ["AGENT.md"],
    companions: [{ match: "instructions.md", modes: ["prose"] }],
  },
  {
    kind: "Skill",
    temporalClass: "pinned",
    scope: "collection",
    directory: "skills",
    definitionFile: "skill.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [
      // Both formats of the same filename: frontmatter makes it the legacy definition, its
      // absence makes it the prose body the canonical `skill.yaml` points at.
      { match: "SKILL.md", modes: ["legacy", "prose"] },
      { match: "assets/", modes: ["prose"] },
      { match: "references/", modes: ["prose"] },
      { match: "schemas/", modes: ["prose"] },
      { match: "scripts/", modes: ["executable"] },
    ],
  },
  {
    kind: "Resource",
    temporalClass: "pinned",
    scope: "collection",
    directory: "resources",
    definitionFile: "resource.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: ["schema.yml"],
    companions: [HOOKS],
  },
  {
    kind: "Routine",
    temporalClass: "pinned",
    scope: "collection",
    directory: "routines",
    definitionFile: "routine.yaml",
    definitionModes: ["definition", "legacy"],
    legacyDefinitionFiles: [],
    companions: [HOOKS],
  },
  {
    kind: "Integration",
    temporalClass: "pinned",
    scope: "collection",
    directory: "integrations",
    definitionFile: "integration.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: ["manifest.yml"],
    companions: [
      { match: "connection.yaml", modes: ["managed"] },
      { match: "setup-guide.md", modes: ["prose"] },
      { match: "*.yaml", modes: ["prose"] },
      { match: "*.yml", modes: ["prose"] },
      { match: "*.json", modes: ["prose"] },
      { match: "*.ts", modes: ["executable"] },
    ],
  },
  {
    kind: "SurfaceComponent",
    temporalClass: "pinned",
    scope: "collection",
    directory: "surface-components",
    definitionFile: "component.yaml",
    definitionModes: ["delegated"],
    legacyDefinitionFiles: [],
    companions: [{ match: "views/", modes: ["delegated"] }],
  },
  {
    kind: "ToolContract",
    temporalClass: "pinned",
    scope: "collection",
    directory: "tools",
    definitionFile: "tool.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "ModelProfile",
    temporalClass: "pinned",
    scope: "collection",
    directory: "model-profiles",
    definitionFile: "model-profile.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "Trigger",
    temporalClass: "pinned",
    scope: "collection",
    directory: "triggers",
    definitionFile: "trigger.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "Role",
    temporalClass: "live",
    scope: "collection",
    directory: "roles",
    definitionFile: "role.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "AccessGrant",
    temporalClass: "live",
    scope: "collection",
    directory: "access-grants",
    definitionFile: "access-grant.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "Guardrail",
    temporalClass: "pinned",
    scope: "collection",
    directory: "guardrails",
    definitionFile: "guardrail.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "IntegrationAdapter",
    temporalClass: "pinned",
    scope: "collection",
    directory: "integration-adapters",
    definitionFile: "adapter.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "App",
    temporalClass: "pinned",
    scope: "collection",
    directory: "apps",
    definitionFile: "app.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "KnowledgeSource",
    temporalClass: "pinned",
    scope: "collection",
    directory: "knowledge",
    definitionFile: "knowledge-source.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "MemorySettings",
    temporalClass: "pinned",
    scope: "collection",
    directory: "memory",
    definitionFile: "memory-settings.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
  {
    kind: "Form",
    temporalClass: "pinned",
    scope: "collection",
    directory: "forms",
    definitionFile: "form.yaml",
    definitionModes: ["definition"],
    legacyDefinitionFiles: [],
    companions: [],
  },
] as const satisfies readonly ArtifactLayout[];

type DeclaredArtifactLayoutKind = (typeof ARTIFACT_LAYOUT_ENTRIES)[number]["kind"];
type MissingArtifactLayoutKind = Exclude<ArtifactKind, DeclaredArtifactLayoutKind>;
type ExtraArtifactLayoutKind = Exclude<DeclaredArtifactLayoutKind, ArtifactKind>;
type ArtifactLayoutTotality = [MissingArtifactLayoutKind, ExtraArtifactLayoutKind] extends [
  never,
  never,
]
  ? true
  : never;
const _ARTIFACT_LAYOUT_TOTALITY: ArtifactLayoutTotality = true;
type LayoutForTemporalClass<Class extends TemporalClass> = Extract<
  (typeof ARTIFACT_LAYOUT_ENTRIES)[number],
  { readonly temporalClass: Class }
>;
export type PinnedArtifactKind = LayoutForTemporalClass<"pinned">["kind"];
export type LiveArtifactKind = LayoutForTemporalClass<"live">["kind"];

export const ARTIFACT_LAYOUTS: readonly ArtifactLayout[] = ARTIFACT_LAYOUT_ENTRIES;

const BY_KIND: ReadonlyMap<string, ArtifactLayout> = new Map(
  ARTIFACT_LAYOUTS.map((layout) => [layout.kind, layout])
);
const BY_DIRECTORY: ReadonlyMap<string, ArtifactLayout> = new Map(
  ARTIFACT_LAYOUTS.filter((layout) => layout.scope === "collection").map((layout) => [
    layout.directory,
    layout,
  ])
);
const SINGLETONS: ReadonlyMap<string, ArtifactLayout> = new Map(
  ARTIFACT_LAYOUTS.filter((layout) => layout.scope === "singleton").map((layout) => [
    layout.definitionFile,
    layout,
  ])
);

const DEFINITION_KIND_SET: ReadonlySet<string> = new Set(DEFINITION_KINDS);

/** Whether this kind is validated by the strict `apiVersion`/`kind` schema registry. */
export function isDefinitionKind(kind: string): kind is DefinitionKind {
  return DEFINITION_KIND_SET.has(kind);
}

export function artifactLayout(kind: ArtifactKind): ArtifactLayout | undefined {
  return BY_KIND.get(kind);
}

/** Returns `null` for unknown kinds so callers can fail closed. */
export function temporalClassOf(kind: string): TemporalClass | null {
  return BY_KIND.get(kind)?.temporalClass ?? null;
}

/** True only for known artifact kinds that are safe to read from a Run-pinned bundle. */
export function isPinnedKind(kind: string): kind is PinnedArtifactKind {
  return temporalClassOf(kind) === "pinned";
}

/** True only for known artifact kinds that must be read from the live active version. */
export function isLiveKind(kind: string): kind is LiveArtifactKind {
  return temporalClassOf(kind) === "live";
}

/** Lowercase kebab-case, matching `definitionMetadataSchema`'s slug pattern. */
const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isArtifactSlug(value: string): boolean {
  return value.length > 0 && value.length <= 128 && SLUG.test(value);
}

export interface ClassifiedSoulPath {
  readonly kind: ArtifactKind;
  /** `null` for singletons. */
  readonly slug: string | null;
  /** True when this path carries the artifact's configuration rather than a companion. */
  readonly definition: boolean;
  /** Content checks this path admits. Never empty. */
  readonly modes: readonly ContentMode[];
  readonly layout: ArtifactLayout;
}

function matchesCompanion(companion: ArtifactCompanion, relative: string): boolean {
  if (companion.match.endsWith("/")) return relative.startsWith(companion.match);
  if (companion.match.startsWith("*.")) {
    return !relative.includes("/") && relative.endsWith(companion.match.slice(1));
  }
  return relative === companion.match;
}

/**
 * Resolve a repo-relative POSIX path to the artifact it belongs to.
 *
 * Returns `null` for anything the tree does not govern — the caller rejects it. Traversal and
 * absolute paths are refused here rather than deeper down, so no consumer has to re-derive
 * containment: a path that cannot be classified cannot be written.
 */
export function classifySoulPath(path: string): ClassifiedSoulPath | null {
  if (!containedPath(path)) return null;
  const segments = path.split("/");

  if (segments.length === 1) {
    const singleton = SINGLETONS.get(path);
    if (!singleton) return null;
    return {
      kind: singleton.kind,
      slug: null,
      definition: true,
      modes: singleton.definitionModes,
      layout: singleton,
    };
  }

  const [directory, slug, ...rest] = segments;
  const layout = BY_DIRECTORY.get(directory);
  if (!layout || rest.length === 0 || !isArtifactSlug(slug)) return null;

  const relative = rest.join("/");
  if (relative === layout.definitionFile) {
    return { kind: layout.kind, slug, definition: true, modes: layout.definitionModes, layout };
  }
  if (layout.legacyDefinitionFiles.includes(relative)) {
    return { kind: layout.kind, slug, definition: true, modes: ["legacy"], layout };
  }
  for (const companion of layout.companions) {
    if (matchesCompanion(companion, relative)) {
      const definition = companion.modes.includes("legacy");
      return { kind: layout.kind, slug, definition, modes: companion.modes, layout };
    }
  }
  return null;
}

/** Build the canonical definition path for an artifact. */
export function definitionPath(kind: ArtifactKind, slug?: string): string {
  const layout = BY_KIND.get(kind);
  if (!layout) throw new Error(`Unknown artifact kind: ${kind}`);
  if (layout.scope === "singleton") return layout.definitionFile;
  if (!slug || !isArtifactSlug(slug)) throw new Error(`Invalid slug for ${kind}: ${slug}`);
  return `${layout.directory}/${slug}/${layout.definitionFile}`;
}

/** Build a companion path beside an artifact's definition. */
export function companionPath(kind: ArtifactKind, slug: string, name: string): string {
  const layout = BY_KIND.get(kind);
  if (layout?.scope !== "collection") throw new Error(`Unknown collection kind: ${kind}`);
  if (!isArtifactSlug(slug)) throw new Error(`Invalid slug for ${kind}: ${slug}`);
  const path = `${layout.directory}/${slug}/${name}`;
  if (!classifySoulPath(path)) throw new Error(`Unsupported companion for ${kind}: ${name}`);
  return path;
}

/** The directory holding every artifact of a collection kind. */
export function artifactDirectory(kind: ArtifactKind, slug: string): string {
  const layout = BY_KIND.get(kind);
  if (layout?.scope !== "collection") throw new Error(`Unknown collection kind: ${kind}`);
  if (!isArtifactSlug(slug)) throw new Error(`Invalid slug for ${kind}: ${slug}`);
  return `${layout.directory}/${slug}`;
}

/**
 * Superseded definition paths for an artifact — where an older layout would have filed it.
 *
 * A tree mid-migration may hold both forms, and two definitions for one artifact is an ambiguity
 * the loader would have to break by guessing. Callers use this to detect that state; they do not
 * get to ignore it.
 */
export function legacyDefinitionPaths(kind: ArtifactKind, slug?: string): string[] {
  const layout = BY_KIND.get(kind);
  if (!layout) throw new Error(`Unknown artifact kind: ${kind}`);
  if (layout.scope === "singleton") return [...layout.legacyDefinitionFiles];
  if (!slug || !isArtifactSlug(slug)) throw new Error(`Invalid slug for ${kind}: ${slug}`);
  return layout.legacyDefinitionFiles.map((file) => `${layout.directory}/${slug}/${file}`);
}

/**
 * Whether a path falls inside a directory this registry governs, even if the file itself has no
 * declared role there.
 *
 * This is deliberately weaker than `classifySoulPath` and exists for one case: removing a file
 * that should not be in an artifact's directory — left by an older layout, or by someone editing
 * the repository directly on its remote. Such a file is unclassifiable, so a rule that only
 * permitted classifiable deletes would make it permanently unremovable through the gate, which is
 * precisely the pressure that produces a raw-filesystem bypass.
 *
 * It stays strict about *where*: `.git/`, an invented top-level directory, or anything outside the
 * declared tree is not governed, and so is never reachable by a delete.
 */
export function withinArtifactTree(path: string): boolean {
  if (!containedPath(path)) return false;
  if (classifySoulPath(path) !== null) return true;
  const [head] = path.split("/");
  return BY_DIRECTORY.has(head);
}

/** Whether a path stays inside the Soul tree — no traversal, no absolute or Windows-style path. */
export function containedPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  if (path.includes("\0")) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Every path that could carry this artifact's configuration in a superseded form, in the order a
 * reader should try them.
 *
 * Deliberately wider than `legacyDefinitionPaths`, and the difference is not cosmetic — the two
 * answer different questions:
 *
 * - `legacyDefinitionPaths` asks *"what definitely competes with the canonical file?"* It is the
 *   ambiguity guard, so it must not flag a file that is legitimately allowed to sit beside the
 *   canonical form.
 * - This asks *"where might the configuration actually be?"* A reader that misses a location shows
 *   the operator an artifact that has vanished, so it must err wide.
 *
 * `Skill` is the case that forces the split: `SKILL.md` is a dual-mode companion — with
 * frontmatter it *is* the legacy definition, without it, it is the prose body `skill.yaml` points
 * at. It cannot be listed as a `legacyDefinitionFile` without making the canonical pairing
 * (`skill.yaml` + prose `SKILL.md`) look like an ambiguity, but a reader that skips it loses every
 * unmigrated skill.
 */
export function legacyDefinitionCandidates(kind: ArtifactKind, slug?: string): string[] {
  const layout = BY_KIND.get(kind);
  if (!layout) throw new Error(`Unknown artifact kind: ${kind}`);
  const dualMode = layout.companions
    .filter((c) => c.modes.includes("legacy") && !c.match.endsWith("/") && !c.match.includes("*"))
    .map((c) => c.match);
  const files = [...layout.legacyDefinitionFiles, ...dualMode];
  if (layout.scope === "singleton") return files;
  if (!slug || !isArtifactSlug(slug)) throw new Error(`Invalid slug for ${kind}: ${slug}`);
  return files.map((file) => `${layout.directory}/${slug}/${file}`);
}
