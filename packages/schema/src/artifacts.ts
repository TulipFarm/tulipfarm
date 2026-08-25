import { DEFINITION_KINDS, type DefinitionKind } from "./definitions/index";

/** The authored Soul tree layout; consumers derive paths only from `ARTIFACT_LAYOUTS`. */

/** Governed non-definition artifacts validated outside the definition registry. */
export const DELEGATED_ARTIFACT_KINDS = [
  "SurfaceComponent",
  "GuardrailsPolicy",
  "ObservabilityConfig",
  "SkillsLock",
  "IntegrationsLock",
] as const;
export type DelegatedArtifactKind = (typeof DELEGATED_ARTIFACT_KINDS)[number];

export type ArtifactKind = DefinitionKind | DelegatedArtifactKind;

/** `pinned` is Run-bundle config; `live` authority must reflect revocation for in-flight Runs. */
export const TEMPORAL_CLASSES = ["pinned", "live"] as const;
export type TemporalClass = (typeof TEMPORAL_CLASSES)[number];

/** Content check modes; a path may admit multiple modes during legacy-to-envelope migration. */
export const CONTENT_MODES = [
  "definition",
  "legacy",
  "delegated",
  "prose",
  "executable",
  "managed",
] as const;
export type ContentMode = (typeof CONTENT_MODES)[number];

/** Definition companion; `match` is an exact name, directory prefix, extension glob, or `**`. */
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

/** Collections use only `<directory>/<slug>/<definitionFile>`, with no flat-file exceptions. */
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
    // Skills are `SKILL.md` everywhere in the ecosystem, so that file is the definition rather
    // than prose pointed at by an envelope. Its frontmatter carries the configuration; the
    // canonical document the bundle needs is derived from it on read, never written to the tree.
    definitionFile: "SKILL.md",
    // Frontmatter makes it a definition; without frontmatter the same file is only prose.
    definitionModes: ["legacy", "prose"],
    legacyDefinitionFiles: [],
    companions: [
      // `scripts/` is the one companion the layout has an opinion about; everything else in a
      // Skill package is content-addressed prose.
      { match: "scripts/", modes: ["executable"] },
      // A Skill is a third-party package, so the layout cannot enumerate what it ships. Refusing
      // unlisted filenames rejected real packages whole over one file — `agents/openai.yaml`,
      // `requirements.txt` — and bought no safety: SkillAudit already scans every collected file
      // and bounds symlink escapes, binaries, file size, package size and file count, while
      // `containedPath` still refuses traversal. Whatever survives that is the operator's own risk
      // to accept at the install confirmation.
      { match: "**", modes: ["prose"] },
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
  if (companion.match === "**") return true;
  if (companion.match.endsWith("/")) return relative.startsWith(companion.match);
  if (companion.match.startsWith("*.")) {
    return !relative.includes("/") && relative.endsWith(companion.match.slice(1));
  }
  return relative === companion.match;
}

/** Classify a governed POSIX path; `null` means callers must reject it. */
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
  // A dot-leading segment is tooling state, not artifact content — `.env`, `.npmrc`, `.git/`. The
  // Soul is a git repo cloned on every boot, so storing one commits a credential forever, and the
  // Skill reader would then hand it straight to a model. No layout names such a companion, so the
  // refusal costs nothing and closes the one shape a catch-all companion would otherwise admit.
  if (rest.some((segment) => segment.startsWith("."))) return null;
  for (const companion of layout.companions) {
    if (matchesCompanion(companion, relative)) {
      const definition = companion.modes.includes("legacy");
      return { kind: layout.kind, slug, definition, modes: companion.modes, layout };
    }
  }
  return null;
}

/**
 * Which of an artifact package's own files the layout cannot address.
 *
 * A caller installing a package has to know this before it writes: the write gateway rejects the
 * whole changeset on the first unaddressable path, and the layout registry — not the caller — is
 * what decides which shapes may live beside a definition. `relativePaths` are POSIX paths relative
 * to the artifact's own directory.
 */
export function unstorableArtifactPaths(
  kind: ArtifactKind,
  slug: string,
  relativePaths: readonly string[]
): string[] {
  const layout = BY_KIND.get(kind);
  if (!layout || layout.scope === "singleton" || !isArtifactSlug(slug)) return [...relativePaths];
  return relativePaths.filter(
    (relative) => classifySoulPath(`${layout.directory}/${slug}/${relative}`) === null
  );
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

/** Superseded definition paths; callers use these to reject ambiguous dual definitions. */
export function legacyDefinitionPaths(kind: ArtifactKind, slug?: string): string[] {
  const layout = BY_KIND.get(kind);
  if (!layout) throw new Error(`Unknown artifact kind: ${kind}`);
  if (layout.scope === "singleton") return [...layout.legacyDefinitionFiles];
  if (!slug || !isArtifactSlug(slug)) throw new Error(`Invalid slug for ${kind}: ${slug}`);
  return layout.legacyDefinitionFiles.map((file) => `${layout.directory}/${slug}/${file}`);
}

/** True for governed directories too, so gates can delete stray unclassifiable files there. */
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

/** Wider than `legacyDefinitionPaths`; includes dual-mode candidates like `SKILL.md`. */
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
