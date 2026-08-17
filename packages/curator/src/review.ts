/**
 * What an operator may see of a recorded effect while judging whether the loop is safe to enable.
 *
 * Shadow output has to be readable — "validated before go-live" is not a claim anyone can make
 * about a table nobody can read. But two effect kinds carry model-derived text about one person: a
 * memory patch *is* that person's document, and a Proposal's rationale is an argument about them.
 * The other three are business-bound content already destined for a page the whole business reads,
 * so showing them early reveals nothing that was going to stay private.
 *
 * So content goes to its own subject, and to everyone else only as shape: the closed vocabularies
 * and counts. That is enough to judge the loop — volume, which sections it touches, what it wants
 * to suggest, whether it cites at all — without making a migration check into a way to read what
 * the system learned about a colleague.
 */

/** The kinds whose payload is an assertion about one person rather than about the business. */
const PRIVATE_EFFECT_KINDS: ReadonlySet<string> = new Set(["memory_patch", "proposal"]);

export function isPrivateEffectKind(kind: string): boolean {
  return PRIVATE_EFFECT_KINDS.has(kind);
}

/**
 * Closed vocabularies and counts only. Every field here is either server-derived or drawn from a
 * fixed set, so none of it can carry a sentence the model wrote about someone.
 */
export interface ShadowEffectShape {
  readonly section?: string;
  readonly proposalKind?: string;
  readonly subjectLabel?: string;
  readonly deliver?: readonly string[];
  readonly addCount?: number;
  readonly removeCount?: number;
  readonly citationCount?: number;
}

export type ShadowEffectView =
  | { readonly disclosure: "full"; readonly payload: unknown }
  | { readonly disclosure: "shape"; readonly shape: ShadowEffectShape };

/**
 * @param viewerIsSubject whether the caller is the user this job reasoned about. Business-scoped
 * jobs have no subject, and pass `false` — they carry no private kinds to withhold anyway.
 */
export function redactShadowEffect(
  effect: { readonly kind: string; readonly payload: unknown },
  viewerIsSubject: boolean
): ShadowEffectView {
  if (viewerIsSubject || !isPrivateEffectKind(effect.kind)) {
    return { disclosure: "full", payload: effect.payload };
  }
  return { disclosure: "shape", shape: shapeOf(effect.kind, effect.payload) };
}

/** One recorded effect as a reviewer may see it: identity, outcome, and whatever it may disclose. */
export interface ShadowEffectProjection {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly scope: string;
  readonly createdAt: string;
  readonly disclosure: ShadowEffectView["disclosure"];
  readonly content: unknown;
}

export function projectShadowEffect(
  row: {
    readonly id: string;
    readonly kind: string;
    readonly state: string;
    readonly scope: string;
    readonly createdAt: Date;
    readonly payload: unknown;
  },
  viewerIsSubject: boolean
): ShadowEffectProjection {
  const view = redactShadowEffect(row, viewerIsSubject);
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    disclosure: view.disclosure,
    content: view.disclosure === "full" ? view.payload : view.shape,
  };
}

function shapeOf(kind: string, payload: unknown): ShadowEffectShape {
  const record = (payload ?? {}) as Record<string, unknown>;
  const citationCount = countOf(record.citations);
  if (kind === "memory_patch") {
    return {
      ...(typeof record.section === "string" ? { section: record.section } : {}),
      addCount: countOf(record.add),
      removeCount: countOf(record.remove),
      citationCount,
    };
  }
  return {
    ...(typeof record.proposalKind === "string" ? { proposalKind: record.proposalKind } : {}),
    // Server-resolved from the business's own objects, never model text — and the single most
    // useful field for telling "suggest triage for repo X" apart from a wrong target.
    ...(typeof record.subjectLabel === "string" ? { subjectLabel: record.subjectLabel } : {}),
    ...(Array.isArray(record.deliver) ? { deliver: record.deliver.map(String) } : {}),
    citationCount,
  };
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
