import { createHash } from "node:crypto";
import { type ProposalSubjectKind, RESOURCE_TEMPLATES } from "./proposal";

/** An existing Soul artifact a Proposal may name, with the label the server will render. */
export interface CuratorSubject {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
}

/**
 * The Soul, as much of it as the Curator is allowed to reason over.
 *
 * Declared structurally rather than imported from `@tulipfarm/soul` so this package keeps its
 * no-I/O boundary: a loader would bring the filesystem in with it.
 */
export interface CuratorSoulView {
  readonly resources: ReadonlyMap<string, unknown>;
  readonly agents: ReadonlyMap<string, unknown>;
  readonly skills: ReadonlyMap<string, unknown>;
  readonly integrations: ReadonlyMap<string, unknown>;
  readonly routines: ReadonlyMap<string, unknown>;
  readonly manifest: Record<string, unknown> | null;
}

/**
 * Every subject a Proposal may name, with the label the server will render.
 *
 * Skills and Routines are absent because no proposal kind takes one as its subject — a subject the
 * Curator cannot name is one it must not see, or it will spend output on proposals that resolve to
 * nothing. `resource_template` names Resource types that do not exist yet, so it comes from the
 * closed menu rather than from Soul.
 */
export function soulSubjects(soul: CuratorSoulView): CuratorSubject[] {
  const subjects: CuratorSubject[] = [];
  const collect = (kind: ProposalSubjectKind, entries: ReadonlyMap<string, unknown>): void => {
    for (const [id, artifact] of entries) {
      subjects.push({ kind, id, label: labelOf(artifact) ?? id });
    }
  };
  collect("resource_type", soul.resources);
  collect("agent", soul.agents);
  collect("integration", soul.integrations);
  for (const [id, label] of Object.entries(RESOURCE_TEMPLATES)) {
    if (!soul.resources.has(id)) subjects.push({ kind: "resource_template", id, label });
  }
  return subjects;
}

/** What the business is and what it has built, as one paragraph for the business Run's prompt. */
export function soulSummary(soul: CuratorSoulView): string {
  const name = stringField(soul.manifest, "businessName") ?? "(unnamed business)";
  const description = stringField(soul.manifest, "businessDescription") ?? "(no description)";
  const listing = (label: string, entries: ReadonlyMap<string, unknown>): string =>
    `- ${label}: ${[...entries.keys()].sort().join(", ") || "(none)"}`;
  return [
    `Name: ${name}`,
    `Description: ${description}`,
    listing("resource types", soul.resources),
    listing("agents", soul.agents),
    listing("skills", soul.skills),
    listing("routines", soul.routines),
    listing("integrations", soul.integrations),
  ].join("\n");
}

function labelOf(artifact: unknown): string | undefined {
  if (typeof artifact !== "object" || artifact === null) return undefined;
  const record = artifact as Record<string, unknown>;
  for (const key of ["displayName", "title", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function stringField(manifest: Record<string, unknown> | null, key: string): string | undefined {
  const value = manifest?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Identifies the Soul a business job reasoned over.
 *
 * Over the same projection the prompt is built from, not over the whole Soul: a change the Curator
 * cannot see must not retire its jobs, and a change it can see must.
 */
export function soulDigest(soul: CuratorSoulView): string {
  return createHash("sha256").update(soulSummary(soul), "utf8").digest("hex");
}
