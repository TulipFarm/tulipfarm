import { createHash, randomUUID } from "node:crypto";
import type {
  AuthInjectionLocation,
  ConnectionPrincipal,
  ConnectionUseAuthorizer,
} from "@tulipfarm/integrations";
import { isSessionHeader, normalizedPublicUrl } from "@tulipfarm/integrations";
import type { OimConnection } from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import type { ConnectionStore, PersistedConnection } from "@tulipfarm/storage";

/**
 * Ad-hoc Connections created from a provider's own authentication challenge.
 *
 * An ad-hoc credential has no installed Integration behind it, so the *origin* is its identity.
 * Deriving the integration id from the origin rather than storing the origin as a searchable field
 * keeps one rule true: a Connection can only ever be offered for the exact origin it was confirmed
 * for. There is no query that could return a near match.
 */

/** The one credential slot an ad-hoc Connection binds. */
export const ADHOC_CREDENTIAL_SLOT = "credential";
export const ADHOC_MAJOR_VERSION = 1;

/**
 * The synthetic Integration identity for an origin.
 *
 * Hashed rather than spelled out because `SLUG_PATTERN` cannot hold a port or a scheme, and
 * flattening `https://api.example.com` and `http://api.example.com:8080` onto one slug would let a
 * credential confirmed for one be offered for the other.
 */
export function adhocIntegrationId(origin: string): string {
  const canonical = normalizedPublicUrl(origin).origin;
  return `adhoc-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export interface AdhocInjectionRule {
  readonly location: AuthInjectionLocation;
  readonly name: string;
  readonly valuePrefix: string;
}

export class AdhocConnectionError extends Error {
  constructor(readonly code: "session_header" | "invalid_origin" | "invalid_rule") {
    super(code);
    this.name = "AdhocConnectionError";
  }
}

/**
 * Validates the rule a person confirmed.
 *
 * Rejects a browser session outright: pasting `Cookie` works against most sites, which is why it
 * has to be refused rather than warned about — it delegates an entire authenticated session, in
 * place of a token whose reach the person could reason about.
 */
export function assertUsableRule(rule: AdhocInjectionRule): void {
  if (rule.name.trim().length === 0) throw new AdhocConnectionError("invalid_rule");
  if (rule.location === "header" && isSessionHeader(rule.name)) {
    throw new AdhocConnectionError("session_header");
  }
}

function canonicalOrigin(origin: string): string {
  try {
    return normalizedPublicUrl(origin).origin;
  } catch {
    throw new AdhocConnectionError("invalid_origin");
  }
}

export interface CreateAdhocConnectionInput {
  readonly businessId: string;
  readonly origin: string;
  readonly rule: AdhocInjectionRule;
  /** Never passes through a model: routes take it straight from the person's browser. */
  readonly secretValue: string;
  readonly label: string;
  readonly owner: OimConnection["owner"];
}

/** The read half of the store, so a lookup cannot reach the writer. */
export type ConnectionReader = Pick<ConnectionStore, "findById" | "listForIntegration">;

export interface AdhocConnectionDeps {
  readonly connections: Pick<ConnectionStore, "put">;
  readonly secrets: SecretsService;
  readonly newId?: () => string;
}

/**
 * Creates a destination-bound Connection from a confirmed rule.
 *
 * The Secret is written before the Connection so a crash between the two leaves an orphaned Secret
 * rather than a Connection pointing at nothing — the first is invisible, the second would present
 * itself as usable and fail at dispatch.
 */
export async function createAdhocConnection(
  deps: AdhocConnectionDeps,
  input: CreateAdhocConnectionInput
): Promise<{ readonly connectionId: string; readonly origin: string }> {
  assertUsableRule(input.rule);
  const origin = canonicalOrigin(input.origin);
  const newId = deps.newId ?? (() => randomUUID());
  const secretKey = `adhoc-${newId().replace(/-/g, "")}`;
  await deps.secrets.set(secretKey, input.secretValue);

  const connectionId = newId();
  await deps.connections.put(input.businessId, {
    id: connectionId,
    integration: { id: adhocIntegrationId(origin), majorVersion: ADHOC_MAJOR_VERSION },
    label: input.label,
    owner: input.owner,
    status: "active",
    isDefault: true,
    // The origin is Agent-visible so a model can say which destination it is about to act on. The
    // header name and prefix are not: they describe where the credential goes, which is the host's
    // business, and naming them in Context invites a model to reconstruct the request by hand.
    configuration: {
      origin,
      location: input.rule.location,
      name: input.rule.name,
      valuePrefix: input.rule.valuePrefix,
    },
    agentVisibleConfiguration: ["origin"],
    secretBindings: { [ADHOC_CREDENTIAL_SLOT]: `secret://${secretKey}` },
    health: { status: "healthy", checkedAt: new Date().toISOString() },
    expiresAt: null,
  });
  return { connectionId, origin };
}

/** The confirmed rule held by a Connection, or `undefined` when it does not carry a usable one. */
export function ruleOf(connection: PersistedConnection): AdhocInjectionRule | undefined {
  const { location, name, valuePrefix } = connection.configuration;
  if (
    (location !== "header" && location !== "query") ||
    typeof name !== "string" ||
    typeof valuePrefix !== "string"
  ) {
    return undefined;
  }
  const rule: AdhocInjectionRule = { location, name, valuePrefix };
  try {
    assertUsableRule(rule);
  } catch {
    return undefined;
  }
  return rule;
}

export type AdhocMatch =
  | { readonly kind: "none" }
  | {
      readonly kind: "ambiguous";
      readonly count: number;
      readonly candidates: readonly AdhocConnectionCandidate[];
    }
  | { readonly kind: "denied"; readonly reason: "not_found" | "not_authorized" | "unavailable" }
  | {
      readonly kind: "match";
      readonly connection: PersistedConnection;
      readonly rule: AdhocInjectionRule;
      readonly credentialRef: string;
    };

export interface AdhocConnectionCandidate {
  readonly id: string;
  readonly label: string;
  readonly ownerScope: OimConnection["owner"]["scope"];
}

function belongsToOrigin(connection: PersistedConnection, origin: string): boolean {
  if (
    connection.integration.id !== adhocIntegrationId(origin) ||
    connection.integration.majorVersion !== ADHOC_MAJOR_VERSION
  ) {
    return false;
  }
  try {
    return canonicalOrigin(String(connection.configuration.origin)) === origin;
  } catch {
    return false;
  }
}

function usableBinding(
  connection: PersistedConnection
): { readonly rule: AdhocInjectionRule; readonly credentialRef: string } | undefined {
  const rule = ruleOf(connection);
  const credentialRef = connection.secretBindings[ADHOC_CREDENTIAL_SLOT];
  if (
    connection.status !== "active" ||
    connection.health.status === "action_required" ||
    (connection.expiresAt !== null && new Date(connection.expiresAt) <= new Date()) ||
    rule === undefined ||
    credentialRef === undefined
  ) {
    return undefined;
  }
  return { rule, credentialRef };
}

async function mayUseConnection(
  principal: ConnectionPrincipal,
  connection: PersistedConnection,
  connectionAccess: ConnectionUseAuthorizer | undefined
): Promise<boolean> {
  if (connection.owner.scope === "personal") {
    if (principal.kind !== "user" || principal.id !== connection.owner.principalId) return false;
    if (connectionAccess === undefined) return true;
  }
  if (connectionAccess === undefined) return false;
  try {
    return await connectionAccess.canUse(principal, connection);
  } catch {
    return false;
  }
}

function candidateOf(connection: PersistedConnection): AdhocConnectionCandidate {
  return {
    id: connection.id,
    label: connection.label,
    ownerScope: connection.owner.scope,
  };
}

/**
 * Finds the caller's single authorized Connection for an exact origin.
 *
 * Two matches is not a tie to break: choosing between a person's own credential and an
 * organization's silently spends one of them under the other's name, so it asks instead.
 */
export async function matchAdhocConnection(
  deps: {
    readonly connections: ConnectionReader;
    readonly connectionAccess?: ConnectionUseAuthorizer;
  },
  input: {
    readonly businessId: string;
    readonly origin: string;
    readonly principalId: string;
    readonly connectionId?: string;
  }
): Promise<AdhocMatch> {
  let origin: string;
  try {
    origin = canonicalOrigin(input.origin);
  } catch {
    return { kind: "none" };
  }
  const integration = { id: adhocIntegrationId(origin), majorVersion: ADHOC_MAJOR_VERSION };
  const principal = { kind: "user", id: input.principalId } as const;
  if (input.connectionId !== undefined) {
    const connection = await deps.connections.findById(input.businessId, input.connectionId);
    if (connection === null || !belongsToOrigin(connection, origin)) {
      return { kind: "denied", reason: "not_found" };
    }
    if (!(await mayUseConnection(principal, connection, deps.connectionAccess))) {
      return { kind: "denied", reason: "not_authorized" };
    }
    const binding = usableBinding(connection);
    if (binding === undefined) return { kind: "denied", reason: "unavailable" };
    return { kind: "match", connection, ...binding };
  }

  const connections = await deps.connections.listForIntegration(input.businessId, integration);
  const usable: {
    readonly connection: PersistedConnection;
    readonly rule: AdhocInjectionRule;
    readonly credentialRef: string;
  }[] = [];
  for (const connection of connections) {
    if (!belongsToOrigin(connection, origin)) continue;
    const binding = usableBinding(connection);
    if (binding === undefined) continue;
    if (!(await mayUseConnection(principal, connection, deps.connectionAccess))) continue;
    usable.push({ connection, ...binding });
  }
  if (usable.length === 0) return { kind: "none" };
  if (usable.length > 1) {
    return {
      kind: "ambiguous",
      count: usable.length,
      candidates: usable.map(({ connection }) => candidateOf(connection)),
    };
  }
  const selected = usable[0];
  if (selected === undefined) return { kind: "none" };
  return { kind: "match", ...selected };
}
