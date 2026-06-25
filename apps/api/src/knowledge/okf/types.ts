// Open Knowledge Format (OKF) layer types — the parsed/serializable shape of a concept file.
// These are NOT the DB row types (those live in ../types.ts); the service maps between them.

/** TulipFarm-specific frontmatter extension fields (parsed from `x-tf-*` keys). All optional. */
export interface OkfTfFields {
  domain: string | null;
  alwaysLoadForAgents: boolean | null;
  source: string | null;
  active: boolean | null;
  version: number | null;
}

/** A cross-space link target parsed from a `tf:page/<BundleName>/<path>` href. */
export interface CrossPageLink {
  bundleName: string;
  path: string;
}

/** The parsed representation of a single OKF concept file (frontmatter + body). */
export interface OkfConcept {
  title: string | null;
  description: string | null;
  resource: string | null;
  tags: string[];
  /** ISO 8601 string from `timestamp`, or null. */
  timestamp: string | null;
  /** Unknown frontmatter keys preserved for round-trip (excludes standard + `x-tf-*` keys). */
  extra: Record<string, unknown>;
  /** TulipFarm extension state parsed from `x-tf-*` keys. */
  tf: OkfTfFields;
  /** Markdown body (everything after the frontmatter). */
  body: string;
  /** Raw bundle-relative link targets captured from the body, as written (resolve via resolveLink). */
  links: string[];
  /** Cross-space links (`tf:page/<BundleName>/<path>`) captured from the body. */
  crossLinks: CrossPageLink[];
}
