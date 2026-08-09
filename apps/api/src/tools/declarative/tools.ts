import { createHash } from "node:crypto";
import {
  type CompiledEgressTool,
  compileOpenApiEgress,
  type EgressHttpPort,
  OpenApiToolAdapter,
} from "@tulipfarm/integrations";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretProvider,
  type SecretsService,
} from "@tulipfarm/secrets";
import type { Logger, SoulIntegration } from "@tulipfarm/soul";
import {
  CredentialDispatcher,
  EffectDispatcher,
  type EffectStore,
  intentDigest,
  normalizeToolIntent,
  type ToolAdapter,
  ToolCatalog,
  ToolDispatchError,
} from "@tulipfarm/tool-broker";
import { integrationSecretKey, isSecretRef } from "../../integrations/connection-env";
import { err, ok, type RequestContext, type ToolCallResult, type ToolDef } from "../types";

/**
 * Turns a manifest's declared egress into live chat Tools.
 *
 * This is the piece that makes the declarative framework real. Before it, a manifest could be
 * listed, installed, and connected, but `egress` was only ever validated and projected — never
 * executed — so the only integrations that produced working Tools were the two whose Tools are
 * hand-written TypeScript (`../github`, `../slack`), which is exactly what a third-party manifest
 * is forbidden to ship (`@tulipfarm/soul`'s `integration-trust.ts`).
 *
 * Manifest Tools go through the **same** governed path as those two: `EffectStore.reserve` for
 * replay-safe idempotency, then `EffectDispatcher.dispatch` for the credential lease and the call.
 * Declarative authorship changes who writes an integration, not how far the platform trusts it — a
 * manifest-declared mutation has to be as replay-safe and as auditable as a hand-written one.
 */

/** Tool names are namespaced by slug so two integrations may both publish `search`. */
export function declarativeToolName(slug: string, toolName: string): string {
  return `${slug}_${toolName}`;
}

/** The secret ref a compiled tool's credential lease resolves through. */
export function egressSecretRef(slug: string, tokenEnv: string): string {
  return `secret://integrations/${slug}/egress/${tokenEnv}`;
}

/** Dresses a digest as an RFC 4122 v4 uuid, the same technique `../slack/tools.ts` uses. */
function derivedId(...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex");
  const version = `4${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    version,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function mapDispatchError(error: ToolDispatchError, slug: string): ToolCallResult {
  switch (error.detail) {
    case "provider_unauthorized":
      return err(
        "internal_error",
        `${slug} rejected the credential — reconnect the integration to refresh it.`
      );
    case "provider_not_found":
      return err("not_found", `${slug} has no such record.`);
    case "provider_rate_limited":
      return err("internal_error", `${slug} is rate limiting this call; try again shortly.`);
    case "credential_missing":
    case "credential_denied":
      return err("internal_error", `${slug} is not connected.`);
    default:
      return err("internal_error", error.detail ? `${error.code}:${error.detail}` : error.message);
  }
}

/**
 * A rediscovered effect from an earlier attempt at this exact call (same run + call id). The
 * ledger keeps only whether it landed, never the provider's response, so a replay cannot hand the
 * model the original output back — same limitation `../slack/tools.ts` documents.
 */
function replayed(state: string): ToolCallResult {
  if (state === "confirmed") {
    return ok({ replayed: true, note: "This call already completed; not repeated." });
  }
  return err("internal_error", `effect_${state}`);
}

/**
 * Resolves an egress credential from the connection env the operator supplied at connect time.
 *
 * Reuses the sealed value `sealConnectionEnv` already wrote rather than adding a second credential
 * path, exactly as `../slack/credentials.ts` reuses the sealed bot token.
 */
class EgressSecretProvider implements SecretProvider {
  constructor(
    private readonly secretRef: string,
    private readonly storageKey: string,
    private readonly secrets: () => Promise<SecretsService>
  ) {}

  async resolveCurrent(secretRef: string) {
    if (secretRef !== this.secretRef) return null;
    try {
      return { value: await (await this.secrets()).get(this.storageKey) };
    } catch {
      return null;
    }
  }
}

export interface DeclarativeToolingDeps {
  readonly businessId: string;
  readonly effects: EffectStore;
  readonly secrets: () => Promise<SecretsService>;
  /** Injected so tests never reach the network. */
  readonly http: EgressHttpPort;
}

interface CompiledIntegration {
  readonly slug: string;
  readonly tools: readonly CompiledEgressTool[];
  /** Absent for a genuinely public API that declares no credential. */
  readonly credential?: { readonly ref: string; readonly storageKey: string };
}

function compileIntegration(integration: SoulIntegration): CompiledIntegration {
  const { manifest, slug } = integration;
  if (manifest.egress?.type !== "openapi") return { slug, tools: [] };

  // Connection env fills `{VAR}` placeholders in `base_url` — a per-install path segment such as
  // an Atlassian cloud id. Secret references are excluded: the credential has its own placement,
  // and a compiled binding is logged and inspected, so it must never hold one.
  const env = Object.fromEntries(
    Object.entries(integration.connection?.env ?? {}).filter(([, value]) => !isSecretRef(value))
  );
  const tools = compileOpenApiEgress({
    slug,
    egress: manifest.egress,
    document: integration.egressSpec,
    env,
  });
  const tokenEnv = manifest.egress.auth?.token_env;
  if (tokenEnv === undefined) return { slug, tools };
  return {
    slug,
    tools,
    credential: {
      ref: egressSecretRef(slug, tokenEnv),
      storageKey: integrationSecretKey(slug, tokenEnv),
    },
  };
}

function buildToolDef(
  compiled: CompiledEgressTool,
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps,
  dispatcher: EffectDispatcher
): ToolDef {
  const { slug, credential } = integration;

  return {
    name: declarativeToolName(slug, compiled.name),
    tier: "integration",
    mutating: compiled.mutating,
    description: compiled.description,
    inputSchema: compiled.contract.spec.inputSchema,
    async execute(args, ctx: RequestContext): Promise<ToolCallResult> {
      const runId = ctx.runId;
      if (runId === undefined) return err("internal_error", "no run context for this tool call");
      const callId = ctx.toolCallId ?? crypto.randomUUID();
      const stateId = `invoke:${callId}`;
      const toolId = compiled.toolId;

      const intent = normalizeToolIntent({
        intentId: derivedId("egress-intent", runId, stateId, toolId),
        businessId: deps.businessId,
        runId,
        stateId,
        toolId,
        toolVersion: compiled.contract.spec.toolVersion,
        action: compiled.contract.spec.action,
        targetRefs: [],
        arguments: args,
        ...(credential === undefined ? {} : { credentialRef: credential.ref }),
        idempotencyKey: derivedId("egress-idempotency", runId, stateId, toolId),
      });

      const reserved = await deps.effects.reserve({
        effectId: derivedId("egress-effect", runId, stateId, toolId),
        businessId: deps.businessId,
        runId,
        stateId,
        logicalEffectOrdinal: 0,
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        intent,
        guardrailRevision: ctx.guardrailRevision ?? "none",
        createdAt: new Date().toISOString(),
      });
      if (reserved.outcome === "duplicate") return replayed(reserved.effect.state);

      try {
        return ok(await dispatcher.dispatch(deps.businessId, reserved.effect.effectId));
      } catch (error) {
        if (error instanceof ToolDispatchError) return mapDispatchError(error, slug);
        throw error;
      }
    },
  };
}

function dispatcherFor(
  integration: CompiledIntegration,
  deps: DeclarativeToolingDeps
): EffectDispatcher {
  const catalog = ToolCatalog.load(integration.tools.map((tool) => tool.contract));
  const adapters = new Map<string, ToolAdapter>(
    integration.tools.map((tool) => [
      tool.adapterRef,
      new OpenApiToolAdapter({ binding: tool.binding, http: deps.http }),
    ])
  );

  const { credential } = integration;
  // Default-deny, scoped to this integration's own ref: a careless or hostile manifest can never
  // lease another integration's credential, let alone an unrelated platform secret.
  const authorizer: SecretAuthorizer = {
    authorize(scope) {
      if (credential === undefined || scope.secretRef !== credential.ref) {
        return { allowed: false, reason: "not_authorized" };
      }
      return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
    },
  };
  const credentials = new CredentialDispatcher({
    secrets: new SecretBroker({
      provider:
        credential === undefined
          ? { resolveCurrent: async () => null }
          : new EgressSecretProvider(credential.ref, credential.storageKey, deps.secrets),
      authorizer,
    }),
    reauthorize: () => true,
  });

  return new EffectDispatcher({
    store: deps.effects,
    catalog,
    adapters,
    credentialDispatcher: credentials,
  });
}

export interface DeclarativeTooling {
  readonly tools: readonly ToolDef[];
  /** Why an integration published nothing, for the operator-facing log. */
  readonly problems: readonly string[];
}

/**
 * Builds every chat Tool the given integrations declare.
 *
 * Callers pass only connected integrations: publishing a Tool whose credential does not exist yet
 * would hand the model a capability that fails on first use, which reads to the operator as a
 * broken product rather than an unconnected one.
 *
 * A malformed declaration is collected as a problem rather than thrown, because one bad manifest
 * must not stop every other integration's Tools from registering — but it is never silent, since
 * quietly publishing nothing is how an operator ends up with a Connect button that does nothing.
 */
export function buildDeclarativeTools(
  integrations: readonly SoulIntegration[],
  deps: DeclarativeToolingDeps,
  logger?: Logger
): DeclarativeTooling {
  const tools: ToolDef[] = [];
  const problems: string[] = [];

  for (const integration of integrations) {
    let compiled: CompiledIntegration;
    try {
      compiled = compileIntegration(integration);
    } catch (error) {
      const problem = `Integration "${integration.slug}" published no Tools: ${
        error instanceof Error ? error.message : String(error)
      }`;
      problems.push(problem);
      logger?.error(problem);
      continue;
    }
    if (compiled.tools.length === 0) continue;

    const dispatcher = dispatcherFor(compiled, deps);
    for (const tool of compiled.tools) {
      tools.push(buildToolDef(tool, compiled, deps, dispatcher));
    }
  }

  return { tools, problems };
}
