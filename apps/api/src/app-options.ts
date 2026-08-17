/** The full dependency surface `buildApp` accepts; every field is optional so partial assemblies boot. */

import type { EventEmitter } from "node:events";
import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import type { KnowledgeService } from "@tulipfarm/knowledge";
import type { KvService } from "@tulipfarm/kv";
import type { LlmService } from "@tulipfarm/llm";
import type { MemoryDocumentRepo } from "@tulipfarm/memory";
import type { BatchingLogSink } from "@tulipfarm/observability";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import type { HookExecutor } from "@tulipfarm/sandbox";
import type { SecretsService } from "@tulipfarm/secrets";
import type {
  BundledIntegration,
  BundledSkill,
  GitSyncService,
  SoulLoader,
  SoulWriter,
} from "@tulipfarm/soul";
import type { IntegrationStore, TaskStore } from "@tulipfarm/storage";
import type { ApprovalsRepo, ToolApprovalService } from "@tulipfarm/tool-host";
import type { FastifyBaseLogger } from "fastify";
import type { ActivityService } from "./activity/service";
import type { QueryableProbeTarget } from "./admin/health";
import type { OperationalApiDeps } from "./admin/routes";
import type { RoutineApprovalService } from "./approvals/routine-approvals";
import type { AuditReadService } from "./audit/read-service";
import type { AuditService } from "./audit/service";
import type { TokenRepo } from "./auth/api-tokens";
import type { UserInviteRepo } from "./auth/invites";
import type { SessionStore } from "./auth/session-store";
import type { PasswordWriteRepo, ProfileWriteRepo, UserAdminRepo, UserRepo } from "./auth/users";
import type { AuthorizationGateOptions, RouteAuthorizer } from "./authz/route-gate";
import type { AuthzAdminService } from "./authz/service";
import type { ToolRegistry } from "./broker/tool-adapter";
import type { ConversationRepo } from "./chat/conversations";
import type { MessageRepo } from "./chat/messages";
import type { ChatRunCanceller } from "./chat/routes";
import type { ConversationStore } from "./conversations/service";
import type { CuratorReviewDeps } from "./curator/review-routes";
import type { CuratorRouteDeps } from "./curator/routes";
import type { FeedbackRepo } from "./feedback/repo";
import type { FormsRoutesDeps } from "./forms/routes";
import type { HookIngressDeps } from "./hooks/routes";
import type { IdentityRouteDeps } from "./identity/routes";
import type { IngressRoutesDeps } from "./ingress/routes";
import type { IntegrationAuthRequestRepo } from "./integrations/auth-broker";
import type { GitHubInstallDeps } from "./integrations/github-install-routes";
import type { PrincipalProviderTokenRepo } from "./integrations/principal-tokens";
import type { SlackBindDeps } from "./integrations/slack-binding";
import type { ChannelInternalRouteDeps } from "./internal/channel-routes";
import type { InternalTurnRouteDeps } from "./internal/routes";
import type { KillSwitchService } from "./kill-switches/service";
import type { ObservabilityConfig } from "./observability/config";
import type { LogRepo } from "./observability/log-repo";
import type { ResourceRepo } from "./observability/resource-repo";
import type { ObservabilityService } from "./observability/service";
import type { RateLimiter } from "./rate-limit";
import type { RecordAuthorizer } from "./resources/authorize";
import type { CounterStore, ResourceRepoFactory } from "./resources/repo";
import type { CanonicalRoutineAuthoringService } from "./routines/authoring";
import type { RoutineCatalog } from "./routines/catalog";
import type { RunEventRouteDeps } from "./runs/events";
import type { RunReplayDeps } from "./runs/replay";
import type { SetupAdminCreator } from "./setup/first-admin";
import type { SurfaceActionStore } from "./surfaces/action-store";
import type { SurfaceArtifactStore } from "./surfaces/artifact-store";
import type { SystemRoutesDeps } from "./system/routes";
import type { TriggerInvokeDeps } from "./triggers/routes";

export interface AppOptions {
  /** Backs the read-only Memory panel on `/settings/profile`. */
  readonly memoryDocuments?: MemoryDocumentRepo;
  sessionStore?: SessionStore;
  userRepo?: UserRepo;
  userAdminRepo?: UserAdminRepo;
  passwordWriteRepo?: PasswordWriteRepo;
  profileWriteRepo?: ProfileWriteRepo;
  userInviteRepo?: UserInviteRepo;
  tokenRepo?: TokenRepo;
  identity?: Omit<IdentityRouteDeps, "sessionStore" | "userRepo" | "ttlSeconds">;
  rateLimiter?: RateLimiter;
  secretsService?: SecretsService;
  setupAdminCreator?: SetupAdminCreator;
  gitSync?: GitSyncService;
  /**
   * The ADR-007 write gateway. Every authoring surface writes the Soul tree through this; a route
   * that reaches for `fs` plus `gitSync.withSync` instead bypasses validation, atomicity, conflict
   * detection and bundle publication at once.
   */
  soulWriter?: SoulWriter;
  soulLoader?: SoulLoader;
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: Set<string>;
  bundledIntegrations?: ReadonlyMap<string, BundledIntegration>;
  slackBind?: {
    integrations: IntegrationStore;
    businessId: string;
    verifyBotToken?: SlackBindDeps["verifyBotToken"];
  };
  githubInstall?: Pick<
    GitHubInstallDeps,
    "integrations" | "secretsService" | "businessId" | "http" | "soulRepositories"
  >;
  githubStatus?: { integrations: IntegrationStore; businessId: string };
  /**
   * Generic Integration auth broker. Absent in tests that never exercise a provider round trip;
   * `fetchImpl` lets those that do avoid real network calls.
   */
  integrationAuth?: {
    repo: IntegrationAuthRequestRepo;
    fetchImpl?: typeof globalThis.fetch;
    /**
     * Where a *personal* provider credential is sealed (D7). Absent means this deployment cannot
     * hold them and a user-scoped connect is refused — which must stay in step with
     * `CredentialResolver`, or a Tool will deny a call for want of a credential and point the
     * person at a connect flow that cannot issue one.
     */
    tokens: PrincipalProviderTokenRepo | undefined;
  };
  hookExecutor?: HookExecutor;
  resourceRepoFactory?: ResourceRepoFactory;
  counterStore?: CounterStore;
  /**
   * Decides record authority for the REST record routes. Absent leaves them authenticated-only,
   * which is what every test and the pre-authorization boot path want; production wires it.
   */
  recordAuthorizer?: RecordAuthorizer;
  /**
   * Decides route authority for every route carrying a `RouteAuthorization`. Absent falls back to
   * each declaration's own `fallback`, so a deployment or test without it is never widened.
   */
  routeAuthorizer?: RouteAuthorizer;
  /**
   * Serve or merely observe {@link routeAuthorizer}'s answer. Omitted means enforce: a deployment
   * has to opt out of enforcement, and can never fall into shadow mode by leaving a field unset.
   */
  authorizationGate?: AuthorizationGateOptions;
  reconcileResources?: () => Promise<void>;
  /**
   * Projects authored Soul Roles into durable rows. Wired alongside `gitSync` + `toolRegistry` to
   * enable the access-level authoring routes; absent leaves them unregistered, so a deployment
   * without a Soul repository cannot be asked to write one.
   */
  reconcileSoulRoles?: () => Promise<void>;
  domainEventEmitter?: EventEmitter;
  llmService?: LlmService;
  /**
   * Kicks the pg-boss `curator-sweep` queue outside its five-minute cron, so a Task-clearing
   * change (e.g. auto-connecting a subscription LLM provider) reflects in the Companion within
   * seconds instead of up to five minutes. Absent in tests/deployments with no pg-boss wired.
   */
  triggerCuratorSweep?: () => Promise<void>;
  conversationRepo?: ConversationRepo;
  messageRepo?: MessageRepo;
  feedbackRepo?: FeedbackRepo;
  runEvents?: RunEventRouteDeps;
  runReplay?: RunReplayDeps;
  taskStore?: TaskStore;
  kvService?: KvService;
  triggerInvoke?: TriggerInvokeDeps;
  forms?: FormsRoutesDeps;
  knowledgeService?: KnowledgeService;
  toolRegistry?: ToolRegistry;
  /**
   * Composed in `index.ts`, where the effect ledger and secrets service live; absent in tests that
   * never exercise integration Tools.
   */
  declarativeTools?: { sync: () => number; countFor: (slug: string) => number };
  guardrailsService?: GuardrailsService;
  surfaceArtifactStore?: SurfaceArtifactStore;
  surfaceActionStore?: SurfaceActionStore;
  activityService?: ActivityService;
  auditService?: AuditService;
  auditReadService?: AuditReadService;
  observabilityService?: ObservabilityService;
  observabilityConfig?: ObservabilityConfig;
  routineAuthoring?: CanonicalRoutineAuthoringService;
  routineCatalog?: RoutineCatalog;
  approvalsRepo?: ApprovalsRepo;
  routineApprovals?: RoutineApprovalService;
  toolApprovals?: ToolApprovalService;
  /**
   * What `apps/integration-worker` calls back into for the Channel ports it cannot implement
   * locally (identity resolution, Run minting, reply reading, approval decisions). Built per-app
   * rather than eagerly because identity resolution logs through Fastify's logger, which does not
   * exist until `buildApp` has run.
   */
  channels?(log: FastifyBaseLogger): ChannelInternalRouteDeps;
  ingress?: IngressRoutesDeps;
  hookIngress?: HookIngressDeps;
  systemRoutes?: SystemRoutesDeps;
  operationalApi?: OperationalApiDeps;
  /** Stage 3 admin authorization surface — read/assign/group/explain over durable authority. */
  authzAdmin?: AuthzAdminService;
  /** Operator emergency stops over mutating Tool effects. */
  killSwitches?: KillSwitchService;
  /** Persist-first authority shared by Chat and every Trigger ingress. */
  invocations?: DurableInvocationGateway;
  /**
   * Durable Turns for Chat submissions. Required alongside `invocations` — a Run whose request was
   * never recorded as a Turn is not reconstructable, so the chat routes refuse the half-wired pair.
   */
  conversationStore?: ConversationStore;
  runCancel?: ChatRunCanceller;
  /**
   * The turn machinery the Worker calls back into while it cannot import this app. Service
   * principals only; PR 4 moves the implementations into the Worker and this surface goes away.
   */
  internalTurns?: InternalTurnRouteDeps;
  curator?: CuratorRouteDeps;
  /** The admin-facing shadow review surface. Separate from `curator` because that family is
   *  service-only, and one field for both audiences is how a gate gets applied to the wrong one. */
  curatorReview?: CuratorReviewDeps;
  /**
   * Datastore handle backing `/readyz`. Absent (tests, partial assemblies) means readiness reports
   * ok on process liveness alone.
   */
  readiness?: QueryableProbeTarget;
  /**
   * Tees `error`/`fatal` log records into `log_event` so the observability UI can show them. Absent
   * (tests, partial assemblies) leaves logging on stdout exactly as it was.
   */
  logSink?: BatchingLogSink;
  logRepo?: LogRepo;
  resourceRepo?: ResourceRepo;
}
