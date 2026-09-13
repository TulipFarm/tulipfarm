import { generateKeyPairSync } from "node:crypto";
import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import {
  createEd25519OimReleaseSigner,
  createIntegrationAuthoringWorkflow,
  createOimReleaseInstallOperationHost,
  createOimReleaseTrustHost,
  createReviewedCommunityIntegrationInstaller,
  INTEGRATION_AUTHORING_TOOL_POLICIES,
  IntegrationDraftStore,
  installReviewedCommunityOimRelease,
  signOimRevocationList,
} from "@tulipfarm/integrations";
import { INTEGRATION_AUTHORING_TOOL_DECLARATIONS } from "@tulipfarm/schema";
import { OimReleaseOperationStore, OimReleaseTrustStore } from "@tulipfarm/storage";
import {
  defineApiTool,
  InMemoryToolCatalog,
  LiveToolGate,
  RegistryToolDispatcher,
  type RequestContext,
  ToolApprovalService,
  toToolDef,
} from "@tulipfarm/tool-host";
import type { TurnWaitPort } from "@tulipfarm/turn-executor";
import type { EvalSoul } from "../eval-soul.ts";
import type { EvalDatabase } from "./database.ts";
import type { SoulWriterTool } from "./soul-write.ts";

const BUSINESS_ID = "eval";
const PARTICIPANT_ID = "eval";
const SOUL_INTEGRATION_TARGET = "soul.integration";
const [reviewDeclaration, createDeclaration, getDeclaration] =
  INTEGRATION_AUTHORING_TOOL_DECLARATIONS;

export interface EvalIntegrationAuthoring {
  readonly port: ToolDispatchPort;
  readonly waits: TurnWaitPort;
  approvePending(runId: string): Promise<boolean>;
}

export interface EvalIntegrationAuthoringState {
  readonly drafts: IntegrationDraftStore;
  readonly approvals: ToolApprovalService;
  readonly operations: ReturnType<typeof createOimReleaseInstallOperationHost>;
  readonly trust: ReturnType<typeof createOimReleaseTrustHost>;
  readonly trustStore: OimReleaseTrustStore;
}

export async function createEvalIntegrationAuthoringState(
  database: EvalDatabase
): Promise<EvalIntegrationAuthoringState> {
  const trustStore = new OimReleaseTrustStore(database.transactions);
  const trust = createOimReleaseTrustHost(trustStore);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "eval-revocations";
  await trust.addTrustRoot({
    purpose: "revocation",
    keyId,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    createdBy: "eval",
  });
  await trust.updateRevocationList(
    signOimRevocationList(
      {
        sequence: 1,
        issuedAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        revocations: [],
      },
      createEd25519OimReleaseSigner(
        keyId,
        privateKey.export({ format: "pem", type: "pkcs8" }).toString()
      )
    )
  );
  return {
    drafts: new IntegrationDraftStore(),
    approvals: new ToolApprovalService({
      transactions: database.transactions,
      now: () => new Date(),
    }),
    operations: createOimReleaseInstallOperationHost(
      new OimReleaseOperationStore(database.transactions)
    ),
    trust,
    trustStore,
  };
}

function principal(context: RequestContext) {
  return context.subject ?? { kind: "user", id: context.userId };
}

function targets(args: unknown) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const slug = (args as { slug?: unknown }).slug;
  return typeof slug === "string" && slug.length > 0
    ? [{ type: SOUL_INTEGRATION_TARGET, id: slug }]
    : [];
}

export function evalIntegrationAuthoring(options: {
  readonly database: EvalDatabase;
  readonly soul: EvalSoul;
  readonly soulWrites: SoulWriterTool;
  readonly state: EvalIntegrationAuthoringState;
  readonly runId: string;
  readonly turnId: string;
  readonly conversationId: string;
  readonly agentId: string;
}): EvalIntegrationAuthoring {
  const installer = createReviewedCommunityIntegrationInstaller({
    installReviewedCommunityOimRelease,
    releaseDependencies: {
      trust: options.state.trust,
      packageWriter: options.soulWrites.releasePackages,
      provenance: options.state.trust,
      operations: options.state.operations,
      reviewedDrafts: options.state.drafts,
    },
  });
  const workflow = createIntegrationAuthoringWorkflow<RequestContext>({
    drafts: options.state.drafts,
    integrations: () => options.soul.loader.integrations,
    installedGenerations: {
      findInstalledGeneration: (businessId, integrationId, majorVersion) =>
        options.state.trustStore.findInstalledGeneration(businessId, integrationId, majorVersion),
    },
    installer,
  });
  const invocation = (context: RequestContext) => ({
    businessId: BUSINESS_ID,
    principal: principal(context),
    actor: context.actor,
    runId: context.runId,
    toolCallId: context.toolCallId,
    connectionContext: context,
  });
  const definitions = [
    defineApiTool<RequestContext>({
      ...reviewDeclaration,
      tier: "system",
      authorization: {
        action: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_draft_review.action,
        resources: [SOUL_INTEGRATION_TARGET],
        dataClasses: ["soul_definition"],
      },
      requiresApproval:
        INTEGRATION_AUTHORING_TOOL_POLICIES.integration_draft_review.requiresApproval,
      handler: (args, context) => workflow.review(args, invocation(context)),
    }),
    defineApiTool<RequestContext>({
      ...createDeclaration,
      tier: "system",
      authorization: {
        action: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_draft_create.action,
        resources: [SOUL_INTEGRATION_TARGET],
        targets,
        dataClasses: ["soul_definition"],
      },
      requiresApproval:
        INTEGRATION_AUTHORING_TOOL_POLICIES.integration_draft_create.requiresApproval,
      handler: (args, context) => workflow.create(args, invocation(context)),
    }),
    defineApiTool<RequestContext>({
      ...getDeclaration,
      tier: "system",
      authorization: {
        action: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_get.action,
        resources: [SOUL_INTEGRATION_TARGET],
        targets,
        dataClasses: ["soul_definition"],
      },
      requiresApproval: INTEGRATION_AUTHORING_TOOL_POLICIES.integration_get.requiresApproval,
      handler: (args) => workflow.get(args),
    }),
  ];
  const catalog = new InMemoryToolCatalog();
  for (const definition of definitions)
    catalog.register(toToolDef(definition, (context) => context));
  const dispatcher = new RegistryToolDispatcher({
    registry: catalog,
    artifacts: { read: async () => null } as never,
    approvals: options.state.approvals,
    gate: new LiveToolGate(),
    authorityLayers: {
      resolvePrincipalLayer: async () => ({
        name: "eval-participant",
        grants: [
          {
            effect: "allow",
            action: "soul.integration.read",
            resourceType: SOUL_INTEGRATION_TARGET,
          },
          {
            effect: "allow",
            action: "soul.integration.author",
            resourceType: SOUL_INTEGRATION_TARGET,
          },
        ],
      }),
    },
  });

  return {
    port: {
      dispatch: async (call) => {
        const result = await dispatcher.dispatch(
          {
            businessId: BUSINESS_ID,
            runId: options.runId,
            turn: {
              id: options.turnId,
              conversationId: options.conversationId,
              attempt: 1,
            },
            subject: { kind: "user", id: PARTICIPANT_ID },
            source: "chat",
            bundleDigest: "sha256:eval",
            agent: { name: options.agentId },
          },
          call
        );
        return { ...result, callId: call.callId };
      },
    },
    waits: {
      register: ({ businessId, runId, stateKey, approvalId }) =>
        options.state.approvals.registerWait({
          businessId,
          runId,
          stateKey,
          approvalId,
          subject: { kind: "user", id: PARTICIPANT_ID },
        }),
    },
    approvePending: async (runId) => {
      const pending = await options.state.approvals.pendingForRun(runId);
      if (pending?.toolName !== createDeclaration.name) return false;
      return (
        (await options.state.approvals.signal({
          businessId: BUSINESS_ID,
          approvalId: pending.approvalId,
          decision: "approved",
          principal: `user:${PARTICIPANT_ID}`,
        })) === "resumed"
      );
    },
  };
}
