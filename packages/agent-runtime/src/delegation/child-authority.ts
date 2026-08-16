/**
 * Enforcement of a delegated Run's granted authority on the child's own Tool loop.
 *
 * Delegation narrows authority into an immutable `run_child_links` row before the child exists.
 * Nothing read that row afterwards: the child's Turn resolved its Tools from its own Soul Agent
 * config, so a helper granted a read-only Tool set could still call a mutating Tool. This module
 * is the missing half — the child's effective authority is the intersection of what its Soul
 * config offers with what the link row granted, decided by `@tulipfarm/authz`.
 */

import {
  decideEffectivePermission,
  delegatedAuthorityLayer,
  delegatedDataClassRequest,
  delegatedToolRequest,
} from "@tulipfarm/authz";
import type { ChildAuthority, ChildLink, ChildLinkAncestry } from "@tulipfarm/run-kernel";
import type { DelegationCatalogEntry } from "./composition";
import { DELEGATION_DEADLINE_LIMIT_KEY } from "./delegate";

/** What bounds one Run: either nothing (it is a root) or the authority its link row granted. */
export type DelegatedBound =
  | { readonly linked: false }
  | { readonly linked: true; readonly authority: ChildAuthority };

/** Most Runs have no parent link; they are bounded by their subject and Agent config alone. */
export const UNLINKED_RUN: DelegatedBound = { linked: false };

export type ChildAuthorityErrorCode = "link_unreadable";

/** A Run whose granted authority cannot be established. Never falls back to the Soul config. */
export class ChildAuthorityError extends Error {
  readonly name = "ChildAuthorityError";

  constructor(
    readonly code: ChildAuthorityErrorCode,
    options?: { cause?: unknown }
  ) {
    super(code, options);
  }
}

/**
 * Reads the granted authority for one Run from the link row.
 *
 * `links === undefined` states that the deployment composes no delegation at all, which is the
 * only case where an absent bound is a fact rather than an unanswered question. A read that
 * *fails* is an unanswered question and refuses.
 */
export async function resolveDelegatedBound(
  links: ChildLinkAncestry | undefined,
  businessId: string,
  runId: string
): Promise<DelegatedBound> {
  if (links === undefined) return UNLINKED_RUN;
  let link: ChildLink | null;
  try {
    link = await links.parentLink(businessId, runId);
  } catch (cause) {
    throw new ChildAuthorityError("link_unreadable", { cause });
  }
  return link === null ? UNLINKED_RUN : { linked: true, authority: link.authority };
}

/**
 * Intersects the Tools a Run's Soul config offers with the Tools its link row granted.
 *
 * Filtering the offered list is what makes this an intersection in both directions: a Tool the
 * link row grants but the Soul config never offered is not manufactured here.
 */
export function narrowDelegatedTools<T extends { readonly name: string }>(
  offered: readonly T[],
  bound: DelegatedBound
): readonly T[] {
  if (!bound.linked) return offered;
  const layers = [
    delegatedAuthorityLayer("soul", {
      tools: offered.map((tool) => tool.name),
      classifications: [],
    }),
    delegatedAuthorityLayer("delegation", bound.authority),
  ];
  return offered.filter(
    (tool) => decideEffectivePermission(layers, delegatedToolRequest(tool.name)).allowed
  );
}

/**
 * Clamps a Run's turn limits to any ceiling the link row carries for the same key. A key the
 * grant does not mention is not narrowed here; `narrowChildAuthority` already refused any key the
 * parent never held.
 */
export function narrowDelegatedLimits<L extends Readonly<Record<string, number>>>(
  limits: L,
  bound: DelegatedBound
): L {
  if (!bound.linked) return limits;
  const ceilings = bound.authority.limits;
  return Object.fromEntries(
    Object.entries(limits).map(([key, value]) => [key, Math.min(value, ceilings[key] ?? value)])
  ) as L;
}

/** What one Run may do, reduced to what this guard reads. `TurnAuthority` satisfies it. */
export interface DelegatedDispatchAuthority {
  readonly businessId: string;
  readonly runId: string;
}

/**
 * Narrows one turn's offered Tools and limits to what the Run's link row granted. The single
 * entry point for Context assembly, so a caller cannot read the bound and then forget half of it.
 */
export async function narrowDelegatedTurn<
  T extends { readonly name: string },
  L extends Readonly<Record<string, number>>,
>(
  links: ChildLinkAncestry | undefined,
  run: DelegatedDispatchAuthority,
  turn: { readonly tools: readonly T[]; readonly limits: L }
): Promise<{ readonly tools: readonly T[]; readonly limits: L }> {
  const bound = await resolveDelegatedBound(links, run.businessId, run.runId);
  return {
    tools: narrowDelegatedTools(turn.tools, bound),
    limits: narrowDelegatedLimits(turn.limits, bound),
  };
}

export interface DelegatedCall {
  readonly toolName: string;
  /** The data classes the Tool declares it handles; empty needs no classification grant. */
  readonly dataClasses: readonly string[];
  readonly nowMs: number;
}

/**
 * Why a delegated Run may not make this Tool call, or `undefined` when it may.
 *
 * A linked Run always carries a delegation deadline: the coordinator refuses to delegate without
 * one, and `narrowChildAuthority` copies the parent's. A linked Run missing it is a corrupted
 * grant, so it refuses rather than running unbounded.
 */
export function delegatedCallRefusal(
  bound: DelegatedBound,
  call: DelegatedCall
): string | undefined {
  if (!bound.linked) return undefined;
  const layer = [delegatedAuthorityLayer("delegation", bound.authority)];
  if (!decideEffectivePermission(layer, delegatedToolRequest(call.toolName)).allowed) {
    return `tool "${call.toolName}" is outside the authority this Run was delegated`;
  }
  for (const dataClass of call.dataClasses) {
    if (!decideEffectivePermission(layer, delegatedDataClassRequest(dataClass)).allowed) {
      return `tool "${call.toolName}" handles "${dataClass}" data this Run was not delegated`;
    }
  }
  const deadlineMs = bound.authority.limits[DELEGATION_DEADLINE_LIMIT_KEY];
  if (deadlineMs === undefined) {
    return `tool "${call.toolName}" was called by a delegated Run carrying no deadline`;
  }
  if (call.nowMs > deadlineMs) {
    return `tool "${call.toolName}" was called after this Run's delegation deadline`;
  }
  return undefined;
}

/** The refusal shape; a member of the host's own result union, so no import is needed. */
export interface DelegatedDispatchDenial {
  readonly status: "denied";
  readonly reason: string;
}

/** Structural mirror of the host's turn dispatcher; this package must not import the Tool host. */
export interface DelegatedToolDispatcher<
  A extends DelegatedDispatchAuthority,
  C extends { readonly name: string },
  R,
> {
  dispatch(authority: A, call: C): Promise<R>;
}

export interface DelegatedAuthorityGuardDeps {
  readonly links: ChildLinkAncestry;
  /** The live Tool catalog; an unknown Tool declares no data classes and the inner gate denies it. */
  readonly catalog: () => readonly DelegationCatalogEntry[];
  readonly now?: () => Date;
}

/**
 * Wraps a turn Tool dispatcher so every call is checked against the Run's link row first.
 *
 * This is the enforcement point rather than Context assembly because the offered Tool list only
 * shapes what the model is told about; a model may call a Tool it was never offered, and the
 * dispatcher is the single door every Tool call passes through.
 */
export function withDelegatedAuthority<
  A extends DelegatedDispatchAuthority,
  C extends { readonly name: string },
  R,
>(
  deps: DelegatedAuthorityGuardDeps,
  inner: DelegatedToolDispatcher<A, C, R>
): DelegatedToolDispatcher<A, C, R | DelegatedDispatchDenial> {
  const now = deps.now ?? (() => new Date());
  return {
    dispatch: async (authority, call) => {
      let bound: DelegatedBound;
      try {
        bound = await resolveDelegatedBound(deps.links, authority.businessId, authority.runId);
      } catch (error) {
        // An unreadable grant is refused, never widened back to the Soul config. The reason is
        // returned rather than thrown so the turn is answered with a denial like any other.
        if (error instanceof ChildAuthorityError) {
          return {
            status: "denied",
            reason: `tool "${call.name}" could not be checked against this Run's delegated authority`,
          };
        }
        throw error;
      }
      const refusal = delegatedCallRefusal(bound, {
        toolName: call.name,
        dataClasses: deps.catalog().find((tool) => tool.name === call.name)?.dataClasses ?? [],
        nowMs: now().getTime(),
      });
      if (refusal !== undefined) return { status: "denied", reason: refusal };
      return inner.dispatch(authority, call);
    },
  };
}
