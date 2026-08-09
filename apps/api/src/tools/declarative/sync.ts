import type { EgressHttpPort } from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import type { Logger, SoulIntegration } from "@tulipfarm/soul";
import type { EffectStore } from "@tulipfarm/tool-broker";
import type { ToolRegistry } from "../../broker/tool-adapter";
import { buildDeclarativeTools } from "./tools";

/**
 * Keeps the live Tool registry in step with which integrations are connected.
 *
 * Registration cannot be a boot-time act for manifest integrations the way it is for the bundled
 * families: an operator connects Notion at 3pm and expects to use it at 3:01, without a restart.
 * The registry is a long-lived singleton with `register`/`unregister`, so the sync re-derives the
 * whole declarative set and reconciles it — which also means a *disconnect* removes the Tools it
 * added, instead of leaving an agent holding a capability whose credential was just revoked.
 *
 * Only connected integrations publish. An installed-but-unconnected integration has no credential,
 * so its Tools could only ever fail; offering them would read as a broken product rather than an
 * unconnected one.
 */
export interface DeclarativeToolSyncDeps {
  readonly registry: ToolRegistry;
  readonly integrations: () => Iterable<SoulIntegration>;
  readonly businessId: string;
  readonly effects: EffectStore;
  readonly secrets: () => Promise<SecretsService>;
  readonly http: EgressHttpPort;
  /**
   * Resolved lazily: Fastify's logger does not exist until `buildApp`, and this syncer must be
   * constructed before it so `createApp` can receive it.
   */
  readonly logger?: () => Logger | undefined;
}

export class DeclarativeToolSync {
  /** Exactly what this syncer registered last time, so it only ever unregisters its own names. */
  private registered: ReadonlySet<string> = new Set();

  constructor(private readonly deps: DeclarativeToolSyncDeps) {}

  /** Reconciles the registry against the currently connected integrations; returns the live count. */
  sync(): number {
    const logger = this.deps.logger?.();
    const connected = [...this.deps.integrations()].filter(
      (integration) => integration.connection?.enabled === true
    );

    const { tools, problems } = buildDeclarativeTools(
      connected,
      {
        businessId: this.deps.businessId,
        effects: this.deps.effects,
        secrets: this.deps.secrets,
        http: this.deps.http,
      },
      logger
    );

    const next = new Set(tools.map((tool) => tool.name));
    for (const name of this.registered) {
      if (!next.has(name)) this.deps.registry.unregister(name);
    }
    for (const tool of tools) {
      this.deps.registry.register(tool);
    }
    this.registered = next;

    if (problems.length === 0 && tools.length > 0) {
      logger?.info(
        `Declarative Tools: ${tools.length} published by ${connected.length} connected integration(s)`
      );
    }
    return tools.length;
  }

  /** How many Tools one integration currently publishes — the connect response's `toolCount`. */
  countFor(slug: string): number {
    const prefix = `${slug}_`;
    return [...this.registered].filter((name) => name.startsWith(prefix)).length;
  }
}
