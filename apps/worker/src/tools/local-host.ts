import { delegationCatalogOf, withDelegatedAuthority } from "@tulipfarm/agent-runtime";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { FILE_TOOLS, type FileToolContext } from "@tulipfarm/files";
import { KNOWLEDGE_TOOLS, type KnowledgeToolContext, PageReadGate } from "@tulipfarm/knowledge";
import { KV_TOOLS, KvService, type KvToolContext, PgKvRepo } from "@tulipfarm/kv";
import {
  MEMORY_DOCUMENT_TOOLS,
  MemoryDocumentRepo,
  type MemoryDocumentToolContext,
} from "@tulipfarm/memory";
import { PLATFORM_RUNTIME_TOOLS, type PlatformRuntimeContext } from "@tulipfarm/platform-tools";
import type { ArtifactService, DurableWaitManager } from "@tulipfarm/run-kernel";
import {
  type BlobPort,
  ChildLinkAncestryStore,
  type Queryable,
  type TransactionPort,
} from "@tulipfarm/storage";
import {
  type ApiToolDefinition,
  ApprovalsRepo,
  buildLiveAuthorityLayerResolver,
  InMemoryToolCatalog,
  LiveToolGate,
  localDispatchRefusal,
  RegistryToolDispatcher,
  type RequestContext,
  ToolApprovalService,
  type ToolHostLogger,
  type TurnToolDispatcher,
  toToolDef,
} from "@tulipfarm/tool-host";
import { buildWorkerFileService } from "../files/service";
import { buildWorkerKnowledgeService } from "../knowledge/service";
import type { SoulEmbeddings } from "./soul-embeddings";

/**
 * One Tool family plus the context factory that binds it to this process's services.
 *
 * The pairing is the point: a family may only be hosted here if its services can be composed
 * *completely* against local resources. A family that would compose a degraded service belongs
 * on the control plane even when its declarations look co-locatable.
 */
interface HostedFamily<C> {
  readonly definitions: readonly ApiToolDefinition<C>[];
  readonly context: (ctx: RequestContext) => C;
}

function principal(ctx: RequestContext): { userId: string; agentId?: string } {
  return { userId: ctx.userId, ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }) };
}

export interface LocalToolHostOptions {
  readonly db: Queryable;
  readonly transactions: TransactionPort;
  readonly artifacts: ArtifactService;
  readonly waits: DurableWaitManager;
  /** Rebuilt from the control plane's published config before each vector-backed answer. */
  readonly embeddings: SoulEmbeddings;
  /** Absent only when this process runs without pg-boss; page writes then skip re-indexing. */
  readonly enqueueIndexJob?: (pageId: string) => Promise<void>;
  /**
   * Where File bytes live: the same store the control plane writes to, reached through the port.
   *
   * Present so that rendering a model-authored document — untrusted-input processing — happens
   * here rather than in the process that terminates people's HTTP requests.
   */
  readonly blobs: BlobPort;
  /** Defaults to `randomUUID`; present so a test can make an id predictable. */
  readonly newId?: () => string;
  readonly logger?: ToolHostLogger;
}

export interface LocalToolHost {
  readonly dispatcher: TurnToolDispatcher;
  /** Tool names this process answers for; anything else falls back to the control plane. */
  readonly hostedNames: ReadonlySet<string>;
  /**
   * Whether this process can answer `name` as well as the control plane would, right now.
   *
   * Hosting is not a static property. A Tool that ranks by embedding is only safe to answer here
   * while this process's embedder is built from the same published config the control plane uses,
   * and that config changes at runtime. Returning `false` routes the call remote.
   */
  ready(name: string): Promise<boolean>;
}

/** Families whose answers are ranked by the embedder, so their quality tracks its freshness. */
const VECTOR_BACKED = new Set(KNOWLEDGE_TOOLS.map((tool) => tool.name));

function hostedFamilies(options: LocalToolHostOptions): readonly HostedFamily<never>[] {
  const kv = new KvService(new PgKvRepo(options.db));
  const kvFamily: HostedFamily<KvToolContext> = {
    definitions: KV_TOOLS,
    context: (ctx) => ({ ...principal(ctx), service: kv }),
  };
  const platformFamily: HostedFamily<PlatformRuntimeContext> = {
    definitions: PLATFORM_RUNTIME_TOOLS,
    // `complete_state` refuses a call that names no Routine, so dropping the RequestContext here
    // made it unreachable from the very Routine Agent States that exist to call it.
    context: (ctx) =>
      ctx.routineContext === undefined ? {} : { routineContext: ctx.routineContext },
  };
  const documents = new MemoryDocumentRepo(options.transactions);
  // The Memory Document is stored and returned whole, so nothing here ranks by embedding: this
  // family is hosted unconditionally rather than behind the freshness gate.
  const memoryFamily: HostedFamily<MemoryDocumentToolContext> = {
    definitions: MEMORY_DOCUMENT_TOOLS,
    context: (ctx) => ({
      businessId: DEPLOYMENT_BUSINESS_ID,
      ...principal(ctx),
      documents,
      ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
    }),
  };
  const embeddings = options.embeddings;

  const knowledge = buildWorkerKnowledgeService({
    db: options.db,
    embeddings,
    ...(options.enqueueIndexJob === undefined ? {} : { enqueueIndex: options.enqueueIndexJob }),
  });

  // The same gate the API's routes use. Without it every exact-lookup Tool refuses, so a Routine
  // could not read even an unrestricted Page.
  const pageGate = new PageReadGate(options.db);

  const files = buildWorkerFileService(options);
  const fileFamily: HostedFamily<FileToolContext> = {
    definitions: FILE_TOOLS,
    // `principalId` is `userId`, never `agentId`: an Agent's reach into the library is exactly
    // its caller's. `agentId` rides alongside it, and is read only when the Agent *writes* a File,
    // to share it with the Roles that Agent holds. It widens no read.
    context: (ctx) => ({
      businessId: DEPLOYMENT_BUSINESS_ID,
      principalId: ctx.userId,
      ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
      // Recorded on a File this Run authors; it never widens what the Run may read.
      ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
      service: files,
    }),
  };

  const vectorBacked: HostedFamily<KnowledgeToolContext> = {
    definitions: KNOWLEDGE_TOOLS,
    context: (ctx) => ({ ...principal(ctx), service: knowledge, pageGate }),
  };

  return [
    kvFamily,
    platformFamily,
    memoryFamily,
    fileFamily,
    vectorBacked,
  ] as unknown as readonly HostedFamily<never>[];
}

/**
 * Builds the durable runtime's in-process Tool host.
 *
 * Tools whose declarations fail `localDispatchRefusal` are skipped, not fatal: a family is
 * hosted as a unit, and its ineligible members keep taking the control-plane hop.
 */
export function buildLocalToolHost(options: LocalToolHostOptions): LocalToolHost {
  const catalog = new InMemoryToolCatalog();

  for (const family of hostedFamilies(options)) {
    for (const definition of family.definitions) {
      const tool = toToolDef(definition, family.context);
      if (localDispatchRefusal(tool.definition) !== undefined) continue;
      catalog.register(tool);
    }
  }

  // A delegated Run is bounded by its link row wherever it executes: co-locating execution must
  // not co-locate a weaker answer to what the Run may do.
  const dispatcher = withDelegatedAuthority(
    {
      links: new ChildLinkAncestryStore(options.db),
      catalog: delegationCatalogOf(catalog),
    },
    new RegistryToolDispatcher({
      registry: catalog,
      artifacts: options.artifacts,
      gate: new LiveToolGate(),
      // Without this the gate is skipped entirely; the dispatcher's constructor enforces its
      // presence, and it reads the same principal, Role and grant rows the control plane reads.
      authorityLayers: buildLiveAuthorityLayerResolver(options.transactions),
      // Only `decide` is reachable from here. Parking a Run mints a one-use resume token, and that
      // stays on the control-plane path via `HttpTurnHost.register`.
      approvals: new ToolApprovalService({
        repo: new ApprovalsRepo(options.db),
        waits: options.waits,
      }),
      localDispatchOnly: true,
      // No `agents` resolver: this process has no Soul to resolve one from. The Agent's authored
      // autonomy and capability restrictions ride in on `TurnAuthority.agent`, which the control
      // plane fills in from the Soul when the Worker reads the Run's authority.
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    })
  );

  const ready = async (name: string): Promise<boolean> => {
    if (!VECTOR_BACKED.has(name)) return true;
    try {
      await options.embeddings.sync();
      return true;
    } catch {
      // Stale here means "ranks worse than the API would", which is the failure this whole seam
      // exists to prevent. The caller routes remote; it does not proceed on the stale embedder.
      return false;
    }
  };

  return {
    dispatcher,
    hostedNames: new Set(catalog.getAll().map((tool) => tool.name)),
    ready,
  };
}
