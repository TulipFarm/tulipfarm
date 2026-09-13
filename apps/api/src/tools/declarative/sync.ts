import type {
  EgressHttpPort,
  OimFilePort,
  OimFileReadAuthorizationPort,
  OimOperationConnectionResolver,
  OimPaginationRuntime,
} from "@tulipfarm/integrations";
import type { MutationGuard } from "@tulipfarm/observability";
import type { SecretsService } from "@tulipfarm/secrets";
import type { Logger, SoulIntegration } from "@tulipfarm/soul";
import type { EffectRetryParker, EffectRetryWaitReader, EffectStore } from "@tulipfarm/tool-broker";
import type { ToolCallPreparationPort } from "@tulipfarm/tool-host";
import type { ToolRegistry } from "../../broker/tool-adapter";
import { buildDeclarativeTools, type DeclarativeToolingDeps } from "./tools";

/**
 * Registration cannot be a boot-time act for manifest integrations the way it is for the bundled
 * families: an operator connects Notion at 3pm and expects to use it at 3:01, without a restart.
 * The registry is a long-lived singleton with `register`/`unregister`, so the sync re-derives the
 * whole declarative set and reconciles it — which also means a *disconnect* removes the Tools it
 * added, instead of leaving an agent holding a capability whose credential was just revoked. Only
 * connected integrations publish.
 */
export interface DeclarativeToolSyncDeps {
  readonly registry: ToolRegistry;
  readonly integrations: () => Iterable<SoulIntegration>;
  readonly businessId: string;
  readonly effects: EffectStore;
  readonly secrets: () => Promise<SecretsService>;
  readonly http: EgressHttpPort;
  readonly mutationGuard?: MutationGuard;
  readonly connections?: OimOperationConnectionResolver;
  readonly files?: OimFilePort;
  readonly fileReadAuthorization?: OimFileReadAuthorizationPort;
  readonly paginationRuntime?: OimPaginationRuntime;
  readonly parkRetry?: EffectRetryParker;
  readonly retryWaitStatus?: EffectRetryWaitReader;
  readonly authorizeFiles?: DeclarativeToolingDeps["authorizeFiles"];
  /**
   * Resolved lazily: Fastify's logger does not exist until `buildApp`, and this syncer must be
   * constructed before it so `createApp` can receive it.
   */
  readonly logger?: () => Logger | undefined;
}

export class DeclarativeToolSync implements ToolCallPreparationPort {
  private registered: ReadonlySet<string> = new Set();
  private registeredBySlug: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  private preparation: ToolCallPreparationPort | undefined;

  constructor(private readonly deps: DeclarativeToolSyncDeps) {}

  sync(): number {
    const logger = this.deps.logger?.();
    const connected = [...this.deps.integrations()].filter((integration) =>
      integration.oimManifest === undefined
        ? integration.connection?.enabled === true
        : this.deps.connections !== undefined
    );

    const { tools, problems, preparation } = buildDeclarativeTools(
      connected,
      {
        businessId: this.deps.businessId,
        effects: this.deps.effects,
        secrets: this.deps.secrets,
        http: this.deps.http,
        ...(this.deps.connections === undefined ? {} : { connections: this.deps.connections }),
        ...(this.deps.files === undefined ? {} : { files: this.deps.files }),
        ...(this.deps.fileReadAuthorization === undefined
          ? {}
          : { fileReadAuthorization: this.deps.fileReadAuthorization }),
        ...(this.deps.paginationRuntime === undefined
          ? {}
          : { paginationRuntime: this.deps.paginationRuntime }),
        ...(this.deps.parkRetry === undefined ? {} : { parkRetry: this.deps.parkRetry }),
        ...(this.deps.retryWaitStatus === undefined
          ? {}
          : { retryWaitStatus: this.deps.retryWaitStatus }),
        ...(this.deps.authorizeFiles === undefined
          ? {}
          : { authorizeFiles: this.deps.authorizeFiles }),
        ...(this.deps.mutationGuard === undefined
          ? {}
          : { mutationGuard: this.deps.mutationGuard }),
      },
      logger
    );
    this.preparation = preparation;
    const syncProblems = [...problems];

    const desired = new Set(tools.map((tool) => tool.name));
    const registered = new Set<string>();
    const registeredBySlug = new Map<string, Set<string>>();
    for (const name of this.registered) {
      if (!desired.has(name)) this.deps.registry.unregister(name);
    }
    for (const tool of tools) {
      const slug = tool.definition?.provider;
      if (this.registered.has(tool.name)) this.deps.registry.unregister(tool.name);
      try {
        this.deps.registry.register(tool);
      } catch (error) {
        const problem = `Integration "${slug ?? "unknown"}" did not register Tool "${tool.name}": ${
          error instanceof Error ? error.message : String(error)
        }`;
        syncProblems.push(problem);
        logger?.error(problem);
        continue;
      }
      registered.add(tool.name);
      if (slug === undefined) continue;
      const names = registeredBySlug.get(slug) ?? new Set<string>();
      names.add(tool.name);
      registeredBySlug.set(slug, names);
    }
    this.registered = registered;
    this.registeredBySlug = registeredBySlug;

    if (syncProblems.length === 0 && registered.size > 0) {
      logger?.info(
        `Declarative Tools: ${registered.size} published by ${connected.length} connected integration(s)`
      );
    }
    return registered.size;
  }

  countFor(slug: string): number {
    return this.registeredBySlug.get(slug)?.size ?? 0;
  }

  async prepare(input: Parameters<ToolCallPreparationPort["prepare"]>[0]) {
    return await this.preparation?.prepare(input);
  }
}
