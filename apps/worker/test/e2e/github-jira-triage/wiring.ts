import {
  GitHubAdapter,
  type GitHubEffectContext,
  JiraAdapter,
  type JiraEffectContext,
} from "@tulipfarm/integrations";
import type { AccessGrantDefinition } from "@tulipfarm/schema";
import { inMemorySecretProvider, SecretBroker, SecretLeaseDeniedError } from "@tulipfarm/secrets";
import { InMemoryApprovalRepo } from "@tulipfarm/storage";
import {
  CredentialDispatcher,
  EffectDispatcher,
  EffectReconciler,
  MemoryEffectStore,
  ToolApprovalDecisions,
  ToolApprovalGate,
  ToolBroker,
  type ToolCatalog,
  type ToolReconciliationAdapter,
  type ToolReconciliationOutcome,
  type ToolReconciliationRequest,
} from "@tulipfarm/tool-broker";
import {
  AGENT_PRINCIPAL_ID,
  BUSINESS_ID,
  GITHUB_CREDENTIAL,
  GITHUB_INTEGRATION_ID,
  GITHUB_SECRET_REF,
  JIRA_CREDENTIAL,
  JIRA_INTEGRATION_ID,
  JIRA_SECRET_REF,
  JIRA_SITE_URL,
  REPOSITORY,
  triageCatalog,
} from "./fixtures";
import { GitHubProvider, JiraProvider } from "./providers";

/**
 * The governed effect plane the triage tests run against: fake providers, but a real secret
 * broker, real adapters, a real Tool catalog and effect ledger, and the real dispatcher and
 * reconciler on top of them.
 *
 * The four accessors are the levers a test pulls mid-Run — the clock, the two AccessGrant sets,
 * and whether the credential authorizer still says yes. They are read on every call rather than
 * captured, so revoking a grant or freezing the clock changes what the already-built graph does.
 */

export interface TriageWiringOptions {
  /** Milliseconds since epoch; a test may move it forward between States. */
  readonly clock: () => number;
  readonly githubGrants: () => readonly AccessGrantDefinition[];
  readonly jiraGrants: () => readonly AccessGrantDefinition[];
  /** False once a test revokes the credential authorization mid-Run. */
  readonly authorized: () => boolean;
}

export interface TriageWiring {
  readonly github: GitHubProvider;
  readonly jira: JiraProvider;
  readonly secrets: SecretBroker;
  readonly githubAdapter: GitHubAdapter;
  readonly jiraAdapter: JiraAdapter;
  readonly catalog: ToolCatalog;
  readonly broker: ToolBroker;
  readonly effects: MemoryEffectStore;
  readonly approvals: InMemoryApprovalRepo;
  readonly gate: ToolApprovalGate;
  readonly decisions: ToolApprovalDecisions;
  readonly dispatcher: EffectDispatcher;
  readonly reconciler: EffectReconciler;
}

export function createTriageWiring(options: TriageWiringOptions): TriageWiring {
  const now = (): Date => new Date(options.clock());
  const nowIso = (): string => new Date(options.clock()).toISOString();

  const github = new GitHubProvider(GITHUB_CREDENTIAL);
  const jira = new JiraProvider(JIRA_CREDENTIAL, JIRA_SITE_URL);

  const secrets = new SecretBroker({
    provider: inMemorySecretProvider({
      [GITHUB_SECRET_REF]: GITHUB_CREDENTIAL,
      [JIRA_SECRET_REF]: JIRA_CREDENTIAL,
    }),
    authorizer: { authorize: () => ({ allowed: options.authorized() }) },
    now: options.clock,
  });

  const githubContext: GitHubEffectContext = {
    integrationId: GITHUB_INTEGRATION_ID,
    installation: {
      businessId: BUSINESS_ID,
      integrationId: GITHUB_INTEGRATION_ID,
      installationId: "installation-1",
      accountLogin: "tulip",
      repositories: [REPOSITORY],
      permissions: { issues: "write", metadata: "read" },
    },
    principals: [{ kind: "agent", id: AGENT_PRINCIPAL_ID }],
    grants: [],
  };
  const jiraContext: JiraEffectContext = {
    integrationId: JIRA_INTEGRATION_ID,
    site: {
      businessId: BUSINESS_ID,
      integrationId: JIRA_INTEGRATION_ID,
      cloudId: "cloud-1",
      siteUrl: JIRA_SITE_URL,
      projects: ["ENG"],
      permissions: { issues: "write", users: "read" },
    },
    principals: [{ kind: "agent", id: AGENT_PRINCIPAL_ID }],
    grants: [],
  };

  const githubAdapter = new GitHubAdapter({
    http: github,
    context: { resolve: async () => ({ ...githubContext, grants: options.githubGrants() }) },
    now,
  });
  const jiraAdapter = new JiraAdapter({
    http: jira,
    context: { resolve: async () => ({ ...jiraContext, grants: options.jiraGrants() }) },
    now,
  });

  const catalog = triageCatalog();
  const broker = new ToolBroker(catalog);
  const effects = new MemoryEffectStore();
  const approvals = new InMemoryApprovalRepo();
  const gate = new ToolApprovalGate(approvals, effects);
  const decisions = new ToolApprovalDecisions(approvals);

  const adapters = new Map<string, GitHubAdapter | JiraAdapter>([
    ["integration:github", githubAdapter],
    ["integration:jira", jiraAdapter],
  ]);

  const dispatcher = new EffectDispatcher({
    store: effects,
    catalog,
    adapters,
    credentialDispatcher: new CredentialDispatcher({
      secrets,
      reauthorize: () => options.authorized(),
    }),
    now: nowIso,
  });

  /** Reconciliation re-leases credentials; refused leases stay `ambiguous`, never `not_applied`. */
  function leasedReconciler(
    inner: GitHubAdapter | JiraAdapter,
    secretRef: string
  ): ToolReconciliationAdapter {
    return {
      async reconcile(request: ToolReconciliationRequest): Promise<ToolReconciliationOutcome> {
        try {
          const lease = await secrets.lease({
            scope: {
              secretRef,
              toolId: request.intent.toolId,
              targetId: request.intent.targetRefs[0]?.id,
              runId: request.intent.runId,
              stateId: request.intent.stateId,
              purpose: request.operation,
            },
            maxUses: 1,
          });
          return await lease.use((credential) => inner.reconcile(request, credential));
        } catch (error) {
          if (error instanceof SecretLeaseDeniedError) return inner.reconcile(request);
          throw error;
        }
      },
    };
  }

  const reconciler = new EffectReconciler({
    store: effects,
    catalog,
    adapters: new Map<string, ToolReconciliationAdapter>([
      ["integration:github", leasedReconciler(githubAdapter, GITHUB_SECRET_REF)],
      ["integration:jira", leasedReconciler(jiraAdapter, JIRA_SECRET_REF)],
    ]),
    now: nowIso,
  });

  return {
    github,
    jira,
    secrets,
    githubAdapter,
    jiraAdapter,
    catalog,
    broker,
    effects,
    approvals,
    gate,
    decisions,
    dispatcher,
    reconciler,
  };
}
