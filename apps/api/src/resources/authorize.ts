import type { AuthorityLayer } from "@tulipfarm/authz";
import { decideEffectivePermission } from "@tulipfarm/authz";
import type { SoulLoader } from "@tulipfarm/soul";
import type { FastifyRequest } from "fastify";
import type { AuthorityPrincipal } from "../identity/authority-layers";

/** REST record routes use Resource Tool targets; direct API calls use only the caller layer. */

/** The five authority verbs the record routes exercise. `record.list` also covers search. */
export type RecordAction =
  | "record.create"
  | "record.list"
  | "record.read"
  | "record.update"
  | "record.delete";

export interface RecordAuthorizationRequest {
  readonly principal: AuthorityPrincipal;
  readonly action: RecordAction;
  readonly type: string;
  /** Present for the single-record routes; absent for create, list and search. */
  readonly id?: string;
}

export interface RecordAuthorizer {
  authorize(request: RecordAuthorizationRequest): Promise<boolean>;
}

interface RecordTarget {
  readonly type: string;
  readonly id?: string;
  readonly domain?: string;
}

/** Record targets match `resources/tools.ts`: type first, then id-specific when present. */
export function recordTargets(
  soulLoader: SoulLoader,
  type: string,
  id?: string
): readonly RecordTarget[] {
  const domain = soulLoader.resources.get(type)?.domain;
  const domainPart = domain === undefined ? {} : { domain };
  const targets: RecordTarget[] = [{ type: "record", id: type, ...domainPart }];
  if (id !== undefined) targets.push({ type: `record.${type}`, id, ...domainPart });
  return targets;
}

export class LiveRecordAuthorizer implements RecordAuthorizer {
  constructor(
    private readonly soulLoader: SoulLoader,
    private readonly layers: {
      resolvePrincipalLayer(name: string, principal: AuthorityPrincipal): Promise<AuthorityLayer>;
    },
    private readonly now: () => Date = () => new Date()
  ) {}

  async authorize(request: RecordAuthorizationRequest): Promise<boolean> {
    const caller = await this.layers.resolvePrincipalLayer(request.principal.kind, {
      id: request.principal.id,
      businessId: request.principal.businessId,
      kind: request.principal.kind,
    });
    const now = this.now();
    // Every target must be allowed, matching `authorizeToolIntent`: reaching a record means
    // reaching both its Resource and the record itself, and a grant covering one is not a grant
    // covering the other.
    for (const target of recordTargets(this.soulLoader, request.type, request.id)) {
      const decision = decideEffectivePermission(
        [caller],
        {
          action: request.action,
          resourceType: target.type,
          ...(target.id === undefined ? {} : { recordId: target.id }),
          ...(target.domain === undefined ? {} : { domain: target.domain }),
          dataClass: "business_record",
        },
        now
      );
      if (!decision.allowed) return false;
    }
    return true;
  }
}

/** The authority principal behind a request, or `undefined` when the kind is not one we model. */
export function recordPrincipalOf(req: FastifyRequest): AuthorityPrincipal | undefined {
  const principal = req.principal;
  if (principal === undefined) return undefined;
  // `RequestPrincipal.kind` is `user | service`; both are `PrincipalKind`s, but the mapping is
  // written out rather than cast so a third kind cannot silently default into one of these.
  const kind = principal.kind === "user" ? "user" : principal.kind === "service" ? "service" : null;
  if (kind === null) return undefined;
  return { id: principal.id, businessId: principal.businessId, kind };
}
