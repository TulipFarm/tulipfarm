import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuthorityLayer,
  type DlpRule,
  type GuardrailRule,
  requiredApproverCount,
} from "@tulipfarm/authz";
import {
  GITHUB_TOOL_CONTRACTS,
  GITHUB_TOOL_IDS,
  GitHubAdapter,
  type GitHubEffectContext,
  githubEffectMarker,
  JIRA_TOOL_CONTRACTS,
  JIRA_TOOL_IDS,
  JiraAdapter,
  type JiraEffectContext,
  jiraEffectLabel,
  normalizeGitHubIssueEvent,
} from "@tulipfarm/integrations";
import { type CompiledState, compileRoutine, type IdentityCeiling } from "@tulipfarm/run-kernel";
import {
  type AccessGrantDefinition,
  ajv,
  DEFINITION_REGISTRATIONS,
  parseYamlDocument,
  routine as routineSchema,
  SchemaRegistry,
} from "@tulipfarm/schema";
import { inMemorySecretProvider, SecretBroker, SecretLeaseDeniedError } from "@tulipfarm/secrets";
import { InMemoryApprovalRepo } from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  CredentialDispatcher,
  EffectDispatcher,
  EffectReconciler,
  type EffectRecord,
  MemoryEffectStore,
  type ReconciliationResult,
  ToolApprovalDecisions,
  ToolApprovalGate,
  ToolApprovalGateError,
  ToolBroker,
  ToolCatalog,
  type ToolIntent,
  type ToolReconciliationAdapter,
  type ToolReconciliationOutcome,
  type ToolReconciliationRequest,
} from "@tulipfarm/tool-broker";
import {
  GitHubProvider,
  JiraProvider,
  type SeedIssueInput,
  type SignedDelivery,
  signGitHubDelivery,
  verifyGitHubSignature,
} from "./providers";

/**
 * Composition harness for the GitHub → Jira triage vertical slice (AW-064, AW-065).
 *
 * This is deliberately *not* a mock of the flow. Every governed component is the real one — the
 * compiled Routine, the Tool Broker, the effect ledger, the Secret Broker, the Approval store, the
 * maintained GitHub and Jira adapters — wired together the way `apps/worker` wires them, with only
 * the model call and the two providers replaced. What the tests assert is therefore a property of
 * the system, not of this file.
 *
 * Two structural decisions carry most of the behaviour:
 *
 * - **Reads dispatch, mutations reserve.** A read Tool is authorized and dispatched under a Secret
 *   lease with no ledger entry; a mutating Tool reserves a durable effect first and dispatches
 *   through it. That is why the asserted effect list contains exactly the external mutations.
 * - **Resuming replays from the start.** There is no cached mid-flow state to trust after an
 *   Approval or a crash. The Routine re-executes, and convergence comes from the idempotency key —
 *   a reserved effect is recognized as a duplicate and its result is read back from the provider
 *   rather than written again.
 */

export const EXAMPLES_DIR = join(
  import.meta.dirname,
  "../../../../../examples/github-issue-triage"
);

const BUSINESS_ID = "biz-triage";
const REPOSITORY = "tulip/farm";
const JIRA_SITE_URL = "https://tulip.atlassian.net";
const GUARDRAIL_REVISION = "guardrail-rev-1";
const APPROVER_ROLE = "issue-triage-approver";
const APPROVAL_TTL_MS = 60 * 60 * 1000;

const AGENT_PRINCIPAL_ID = "66666666-6666-4666-8666-666666666666";
const ROUTINE_PRINCIPAL_ID = "principal-routine";
const GITHUB_INTEGRATION_ID = "44444444-4444-4444-8444-444444444444";
const JIRA_INTEGRATION_ID = "55555555-5555-4555-8555-555555555555";

const GITHUB_SECRET_REF = "secret://integrations/github/issue-triage";
const JIRA_SECRET_REF = "secret://integrations/jira/issue-triage";
const GITHUB_CREDENTIAL = "github-installation-token-7f3a";
const JIRA_CREDENTIAL = "jira-api-token-91b2";
const WEBHOOK_SECRET = "webhook-signing-secret";

const TOOL_ABILITIES = [
  GITHUB_TOOL_IDS.issueRead,
  GITHUB_TOOL_IDS.issueSearch,
  GITHUB_TOOL_IDS.issueComment,
  GITHUB_TOOL_IDS.issueLabel,
  GITHUB_TOOL_IDS.issueAssign,
  GITHUB_TOOL_IDS.issueClose,
  JIRA_TOOL_IDS.issueCreate,
  JIRA_TOOL_IDS.userAvailability,
];

export const IDENTITY_CEILING: IdentityCeiling = {
  principalKind: "agent",
  principalId: AGENT_PRINCIPAL_ID,
  grants: TOOL_ABILITIES,
  maxRiskClass: "high",
};

/** The published GitHub and Jira contracts, loaded exactly as the worker loads them. */
export function triageCatalog(): ToolCatalog {
  return ToolCatalog.load([...GITHUB_TOOL_CONTRACTS, ...JIRA_TOOL_CONTRACTS]);
}

/**
 * Jira account id → GitHub login. A real deployment resolves this through the identity map; the
 * point preserved here is that the Agent never names a GitHub login directly, so a prompt-injected
 * classification cannot assign an arbitrary account.
 */
const DIRECTORY: Readonly<Record<string, string>> = {
  "acct-maya": "maya-dev",
  "acct-lee": "lee-dev",
};

export interface TriageClassification {
  readonly duplicate: boolean;
  readonly duplicateOfIssue?: number;
  readonly labels: readonly string[];
  readonly summary: string;
  readonly reply: string;
  readonly candidateAccountIds: readonly string[];
}

export type TriageStepStatus =
  | "completed"
  | "awaiting_approval"
  | "ambiguous"
  | "failed"
  | "cancelled";

export interface TriageStep {
  readonly state: string;
  readonly status: TriageStepStatus;
  readonly effectId?: string;
}

export interface TriageResult {
  readonly outcome: "completed" | "awaiting_approval" | "blocked" | "cancelled";
  readonly deliveryId: string;
  readonly issueNumber: number;
  readonly steps: readonly TriageStep[];
  readonly citations: readonly string[];
  readonly pendingApprovalId?: string;
  readonly blockedReason?: string;
}

export interface IngressResult {
  readonly status: number;
  readonly outcome?: "accepted" | "duplicate";
  readonly code?: string;
}

export interface DeliveryInput {
  readonly deliveryId: string;
  readonly issueNumber: number;
}

function readDefinition(file: string): unknown {
  return parseYamlDocument(readFileSync(join(EXAMPLES_DIR, file), "utf8"));
}

function accessGrant(registry: SchemaRegistry, file: string): AccessGrantDefinition {
  return registry.validate(readDefinition(file)).document as AccessGrantDefinition;
}

function authored(state: CompiledState): Record<string, unknown> {
  return state.definition as unknown as Record<string, unknown>;
}

function authoredString(state: CompiledState, key: string): string {
  const value = authored(state)[key];
  if (typeof value !== "string") throw new Error(`missing ${key} on state ${state.name}`);
  return value;
}

function toolRefOf(state: CompiledState): { readonly name: string; readonly version: string } {
  const ref = authored(state).toolRef;
  if (ref === null || typeof ref !== "object") throw new Error(`missing toolRef on ${state.name}`);
  const { name, version } = ref as Record<string, unknown>;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`malformed toolRef on ${state.name}`);
  }
  return { name, version };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

/**
 * Authority for this Run: the Routine may act on the Tools the Routine declares, and nothing here
 * widens that. The narrowing that actually matters — which repository and which Jira project — is
 * enforced by the AccessGrants inside the adapters, one layer further out.
 */
const AUTHORITY_LAYERS: readonly AuthorityLayer[] = [
  { name: "routine", grants: [{ action: "*", resourceType: "*", effect: "allow" }] },
];

/** Assigning and closing are the two steps a human signs off; everything else is policy-allowed. */
const GUARDRAIL_RULES: readonly GuardrailRule[] = [
  { id: "triage-allow", effect: "allow", action: "*", resourceType: "*" },
  {
    id: "triage-approve-assign",
    effect: "require_approval",
    action: GITHUB_TOOL_IDS.issueAssign,
    resourceType: "*",
  },
  {
    id: "triage-approve-close",
    effect: "require_approval",
    action: GITHUB_TOOL_IDS.issueClose,
    resourceType: "*",
  },
];

const DLP_RULES: readonly DlpRule[] = [
  { dataClass: "source_content", allowedDestinations: ["github", "jira"] },
  { dataClass: "directory", allowedDestinations: ["jira"] },
];

export interface TriageHarness {
  readonly businessId: string;
  readonly github: GitHubProvider;
  readonly jira: JiraProvider;
  readonly effects: MemoryEffectStore;
  readonly approvals: InMemoryApprovalRepo;
  readonly githubCredential: string;
  readonly jiraCredential: string;
  readonly acceptedEvents: readonly string[];

  classify(classification: TriageClassification): void;
  signedDelivery(input: DeliveryInput): SignedDelivery;
  ingest(delivery: SignedDelivery): Promise<IngressResult>;
  triage(input: DeliveryInput): Promise<TriageResult>;
  resume(previous: TriageResult): Promise<TriageResult>;
  approve(approvalId: string, approverIds?: readonly string[]): Promise<void>;
  reconcile(effectId: string): Promise<ReconciliationResult>;

  now(): Date;
  advanceClock(ms: number): void;
  cancelAfter(stateName: string): void;
  revokeAccessGrants(): void;
  revokeAuthorization(): void;
}

export async function createTriageHarness(): Promise<TriageHarness> {
  const registry = new SchemaRegistry(DEFINITION_REGISTRATIONS);
  const routineDefinition = routineSchema.validateRoutineDefinition(
    readDefinition("routine.yaml")
  ).document;
  const compiled = compileRoutine(routineDefinition, { identityCeiling: IDENTITY_CEILING });

  let githubGrants: AccessGrantDefinition[] = [accessGrant(registry, "access-grant.yaml")];
  let jiraGrants: AccessGrantDefinition[] = [accessGrant(registry, "access-grant-jira.yaml")];
  let authorizationActive = true;
  let clock = new Date("2026-03-01T09:00:00.000Z").getTime();
  let classification: TriageClassification | undefined;
  let cancelAfterState: string | undefined;

  const now = (): Date => new Date(clock);
  const nowIso = (): string => new Date(clock).toISOString();

  const github = new GitHubProvider(GITHUB_CREDENTIAL);
  const jira = new JiraProvider(JIRA_CREDENTIAL, JIRA_SITE_URL);

  const secrets = new SecretBroker({
    provider: inMemorySecretProvider({
      [GITHUB_SECRET_REF]: GITHUB_CREDENTIAL,
      [JIRA_SECRET_REF]: JIRA_CREDENTIAL,
    }),
    authorizer: { authorize: () => ({ allowed: authorizationActive }) },
    now: () => clock,
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
    context: { resolve: async () => ({ ...githubContext, grants: githubGrants }) },
    now,
  });
  const jiraAdapter = new JiraAdapter({
    http: jira,
    context: { resolve: async () => ({ ...jiraContext, grants: jiraGrants }) },
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
      reauthorize: () => authorizationActive,
    }),
    now: nowIso,
  });

  /**
   * Reconciliation runs long after the dispatch that leased the credential, so the ledger's
   * reconciler passes none. Wrapping the adapter re-leases under the same authority: if that lease
   * is refused the adapter is called without a credential and answers `ambiguous`, which is the
   * honest result — never an assumed `not_applied`.
   */
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

  const seenDeliveries = new Set<string>();
  const acceptedEvents: string[] = [];

  // ── Trigger ingress ─────────────────────────────────────────────────────────

  function signedDelivery(input: DeliveryInput): SignedDelivery {
    const issue = github.issue(input.issueNumber);
    return signGitHubDelivery(WEBHOOK_SECRET, input.deliveryId, {
      action: "opened",
      repository: { full_name: REPOSITORY },
      installation: { id: 1 },
      sender: { login: issue.author, id: 900 + issue.number },
      issue: {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        html_url: `https://github.com/${REPOSITORY}/issues/${issue.number}`,
        labels: issue.labels.map((name) => ({ name })),
      },
    });
  }

  async function ingest(delivery: SignedDelivery): Promise<IngressResult> {
    // Signature first: an unverified payload is never parsed, stored, or deduplicated on.
    if (!verifyGitHubSignature(WEBHOOK_SECRET, delivery)) {
      return { status: 401, code: "signature_invalid" };
    }
    const deliveryId = delivery.headers["x-github-delivery"];
    if (deliveryId === undefined) return { status: 400, code: "delivery_id_missing" };

    try {
      normalizeGitHubIssueEvent(JSON.parse(delivery.body));
    } catch {
      return { status: 400, code: "payload_rejected" };
    }

    if (seenDeliveries.has(deliveryId)) return { status: 200, outcome: "duplicate" };
    seenDeliveries.add(deliveryId);
    acceptedEvents.push(deliveryId);
    return { status: 202, outcome: "accepted" };
  }

  // ── Agent State ─────────────────────────────────────────────────────────────

  /**
   * Stands in for the bounded Agent loop. It proposes only: it holds no write Tool, and the
   * assignee it names is resolved through the directory rather than taken from issue text, so a
   * prompt-injected classification cannot reach an arbitrary GitHub account.
   */
  function classifyIssue(state: CompiledState): Record<string, unknown> {
    if (classification === undefined) throw new Error("no classification stub configured");
    const assignees = classification.candidateAccountIds
      .slice(0, 1)
      .map((accountId) => DIRECTORY[accountId])
      .filter((login): login is string => login !== undefined);

    const output: Record<string, unknown> = {
      duplicate: classification.duplicate,
      labels: [...classification.labels],
      summary: classification.summary,
      reply: classification.reply,
      candidateAccountIds: [...classification.candidateAccountIds],
      assignees,
    };
    if (classification.duplicateOfIssue !== undefined) {
      output.duplicateOfIssue = classification.duplicateOfIssue;
    }

    // The authored output schema is the boundary: an over-reaching proposal fails here, not at
    // the provider.
    const schema = authored(state).output;
    if (schema !== undefined && !ajv.compile(record(schema))(output)) {
      throw new Error(`ClassifyIssue produced output outside its declared schema`);
    }
    return output;
  }

  // ── Tool States ─────────────────────────────────────────────────────────────

  function targetRefFor(state: CompiledState, input: Record<string, unknown>) {
    const destination = authoredString(state, "destination");
    return destination === "github"
      ? { type: "github.issue", id: `${String(input.repository)}#${String(input.issueNumber)}` }
      : { type: "jira.project", id: String(input.projectKey) };
  }

  function buildIntent(
    state: CompiledState,
    input: Record<string, unknown>,
    deliveryId: string
  ): ToolIntent {
    const ref = toolRefOf(state);
    return {
      intentId: `intent-${deliveryId}-${state.name}`,
      businessId: BUSINESS_ID,
      runId: `run-${deliveryId}`,
      stateId: state.name,
      toolId: ref.name,
      toolVersion: ref.version,
      action: authoredString(state, "action"),
      targetRefs: [targetRefFor(state, input)],
      arguments: input,
      destination: authoredString(state, "destination"),
      credentialRef: authoredString(state, "credentialRef"),
      // Deterministic in the delivery and the State, so a redelivery, a retry, and a resumed Run
      // all converge on the same effect.
      idempotencyKey: `${BUSINESS_ID}:${deliveryId}:${state.name}`,
    };
  }

  function secretRefOf(intent: ToolIntent): string {
    return intent.credentialRef ?? GITHUB_SECRET_REF;
  }

  /** Reads never touch the ledger: nothing external changed, so there is nothing to reconcile. */
  async function dispatchRead(intent: ToolIntent): Promise<unknown> {
    const adapter = intent.destination === "github" ? githubAdapter : jiraAdapter;
    const lease = await secrets.lease({
      scope: {
        secretRef: secretRefOf(intent),
        toolId: intent.toolId,
        targetId: intent.targetRefs[0]?.id,
        runId: intent.runId,
        stateId: intent.stateId,
        purpose: intent.action,
      },
      maxUses: 1,
    });
    return lease.use((credential) =>
      adapter.dispatch({ intent, idempotencyKey: intent.idempotencyKey, attempt: 1 }, credential)
    );
  }

  /**
   * What a confirmed effect produced, read back from the provider. Reached only on a duplicate
   * reservation — a replayed Run must observe the write it already made instead of repeating it.
   */
  function providerOutputFor(effect: EffectRecord): Record<string, unknown> | undefined {
    const source = record(effect.intent.arguments);
    const key = effect.idempotencyKey;

    switch (effect.intent.action) {
      case GITHUB_TOOL_IDS.issueLabel:
        return { labels: [...github.issue(Number(source.issueNumber)).labels] };
      case GITHUB_TOOL_IDS.issueAssign:
        return { assignees: [...github.issue(Number(source.issueNumber)).assignees] };
      case GITHUB_TOOL_IDS.issueClose: {
        const issue = github.issue(Number(source.issueNumber));
        return { number: issue.number, state: issue.state, stateReason: issue.stateReason ?? "" };
      }
      case GITHUB_TOOL_IDS.issueComment: {
        const issueNumber = Number(source.issueNumber);
        const marker = githubEffectMarker(key);
        const comment = github.comments(issueNumber).find((entry) => entry.body.includes(marker));
        return comment === undefined
          ? undefined
          : {
              commentId: comment.id,
              htmlUrl: `https://github.com/${REPOSITORY}/issues/${issueNumber}#issuecomment-${comment.id}`,
              createdAt: comment.createdAt,
            };
      }
      case JIRA_TOOL_IDS.issueCreate: {
        const label = jiraEffectLabel(key);
        const issue = jira.issues().find((entry) => entry.labels.includes(label));
        return issue === undefined
          ? undefined
          : { issueKey: issue.key, issueId: issue.id, url: `${JIRA_SITE_URL}/browse/${issue.key}` };
      }
      default:
        return undefined;
    }
  }

  function citationsFor(state: CompiledState, output: unknown): string[] {
    const value = record(output);
    switch (state.name) {
      case "ReadIssue":
        return [`github:issue:${String(value.repository)}#${String(value.number)}`];
      case "FindDuplicates":
        return (Array.isArray(value.items) ? value.items : []).map((entry) => {
          const item = record(entry);
          return `github:issue:${String(item.repository)}#${String(item.number)}`;
        });
      case "CreateTicket":
        return [`jira:issue:${String(value.issueKey)}`];
      case "ReplyDuplicate":
      case "ReplyTriaged":
        return [`github:comment:${String(value.commentId)}`];
      default:
        return [];
    }
  }

  // ── Run walk ────────────────────────────────────────────────────────────────

  interface WalkState {
    readonly deliveryId: string;
    readonly issueNumber: number;
    readonly mode: "start" | "resume";
    readonly steps: TriageStep[];
    readonly citations: string[];
    readonly outputs: Record<string, unknown>;
    /** Effects reserved by consuming an Approval, keyed by the gated State they authorize. */
    readonly preReserved: Map<string, { readonly effectId: string; readonly created: boolean }>;
  }

  function scopeOf(walk: WalkState): Record<string, unknown> {
    return {
      trigger: { repositoryRef: REPOSITORY, issueNumber: walk.issueNumber },
      states: walk.outputs,
      input: {},
    };
  }

  function inputsFor(state: CompiledState, walk: WalkState): Record<string, unknown> {
    const scope = scopeOf(walk);
    const input: Record<string, unknown> = {};
    for (const mapping of state.inputs) {
      input[mapping.name] =
        mapping.expression === null ? mapping.literal : mapping.expression.evaluate(scope);
    }
    return input;
  }

  function blocked(walk: WalkState, reason?: string): TriageResult {
    return {
      outcome: "blocked",
      deliveryId: walk.deliveryId,
      issueNumber: walk.issueNumber,
      steps: walk.steps,
      citations: walk.citations,
      ...(reason === undefined ? {} : { blockedReason: reason }),
    };
  }

  function effectIdFor(walk: WalkState, stateName: string): string {
    return `effect-${walk.deliveryId}-${stateName}`;
  }

  function reserveInputFor(state: CompiledState, walk: WalkState, intent: ToolIntent) {
    return {
      effectId: effectIdFor(walk, state.name),
      businessId: BUSINESS_ID,
      runId: intent.runId,
      stateId: state.name,
      logicalEffectOrdinal: state.index,
      idempotencyKey: intent.idempotencyKey,
      createdAt: nowIso(),
    };
  }

  /** Runs one Tool State, returning its output or the failed step that stops the Run. */
  async function runToolState(
    state: CompiledState,
    walk: WalkState
  ): Promise<{ readonly output: unknown } | { readonly failure: TriageResult }> {
    const input = inputsFor(state, walk);
    const intent = buildIntent(state, input, walk.deliveryId);
    const contract = catalog.get(intent.toolId, intent.toolVersion);
    if (contract === undefined) {
      walk.steps.push({ state: state.name, status: "failed" });
      return { failure: blocked(walk, "unknown_contract") };
    }

    const gated = walk.preReserved.get(state.name);
    if (gated === undefined) {
      const outcome = broker.authorize(intent, {
        authorityLayers: AUTHORITY_LAYERS,
        guardrailRules: GUARDRAIL_RULES,
        dlpRules: DLP_RULES,
        guardrailRevision: GUARDRAIL_REVISION,
        taint: "untrusted",
        autonomy: "propose_actions",
        now: now(),
      });
      if (outcome.outcome !== "authorized") {
        walk.steps.push({ state: state.name, status: "failed" });
        return {
          failure: blocked(
            walk,
            outcome.outcome === "denied" ? outcome.reason : "approval_required"
          ),
        };
      }
    }

    if (!contract.mutating) {
      try {
        const output = await dispatchRead(intent);
        walk.steps.push({ state: state.name, status: "completed" });
        return { output };
      } catch (error) {
        walk.steps.push({ state: state.name, status: "failed" });
        return {
          failure: blocked(
            walk,
            error instanceof AdapterDispatchError
              ? error.code
              : error instanceof SecretLeaseDeniedError
                ? `credential_${error.reason}`
                : "dispatch_failed"
          ),
        };
      }
    }

    const effectId = gated?.effectId ?? effectIdFor(walk, state.name);
    const created =
      gated !== undefined
        ? gated.created
        : (
            await effects.reserve({
              ...reserveInputFor(state, walk, intent),
              intent,
              intentDigest: outcomeDigest(intent),
              guardrailRevision: GUARDRAIL_REVISION,
            })
          ).outcome === "created";

    if (!created) {
      const effect = await effects.get(BUSINESS_ID, effectId);
      const replayed = effect?.state === "confirmed" ? providerOutputFor(effect) : undefined;
      if (replayed === undefined) {
        const status: TriageStepStatus = effect?.state === "ambiguous" ? "ambiguous" : "failed";
        walk.steps.push({ state: state.name, status, effectId });
        return { failure: blocked(walk, effect?.state ?? "effect_not_found") };
      }
      walk.steps.push({ state: state.name, status: "completed", effectId });
      return { output: replayed };
    }

    try {
      const output = await dispatcher.dispatch(BUSINESS_ID, effectId);
      walk.steps.push({ state: state.name, status: "completed", effectId });
      return { output };
    } catch {
      const effect = await effects.get(BUSINESS_ID, effectId);
      const status: TriageStepStatus = effect?.state === "ambiguous" ? "ambiguous" : "failed";
      walk.steps.push({ state: state.name, status, effectId });
      return { failure: blocked(walk, effect?.state ?? "dispatch_failed") };
    }
  }

  /** The digest the ledger stores alongside a reservation. */
  function outcomeDigest(intent: ToolIntent): string {
    const outcome = broker.authorize(intent, {
      authorityLayers: AUTHORITY_LAYERS,
      guardrailRules: GUARDRAIL_RULES,
      dlpRules: DLP_RULES,
      guardrailRevision: GUARDRAIL_REVISION,
      taint: "untrusted",
      autonomy: "propose_actions",
      now: now(),
    });
    if (outcome.intentDigest === undefined) throw new Error("intent could not be digested");
    return outcome.intentDigest;
  }

  /**
   * An Approval State. Starting a Run raises the Approval and stops; resuming spends it and
   * reserves the effect for the State it gates, so the authorization and the write are one atomic
   * step rather than two hopeful ones.
   */
  async function runApprovalState(
    state: CompiledState,
    walk: WalkState
  ): Promise<TriageResult | undefined> {
    const gatedName = state.transition;
    if (gatedName === null) throw new Error(`approval State ${state.name} gates nothing`);
    const gatedState = compiled.states.get(gatedName);
    if (gatedState === undefined) throw new Error(`unknown gated State ${gatedName}`);

    const input = inputsFor(gatedState, walk);
    const intent = buildIntent(gatedState, input, walk.deliveryId);
    const approvalId = `approval-${walk.deliveryId}-${state.name}`;
    const evidenceHashes = [...walk.citations];

    const outcome = broker.authorize(intent, {
      authorityLayers: AUTHORITY_LAYERS,
      guardrailRules: GUARDRAIL_RULES,
      dlpRules: DLP_RULES,
      guardrailRevision: GUARDRAIL_REVISION,
      taint: "untrusted",
      autonomy: "propose_actions",
      now: now(),
    });
    if (outcome.outcome !== "awaiting_approval") {
      walk.steps.push({ state: state.name, status: "failed" });
      return blocked(walk, outcome.outcome === "denied" ? outcome.reason : "approval_not_required");
    }

    // A resumed Run that reaches an Approval it never raised — because an earlier State was
    // interrupted — raises it now. Only an existing Approval is spent.
    const existing = await approvals.get(BUSINESS_ID, approvalId);
    if (walk.mode === "start" || existing === undefined) {
      if (existing === undefined) {
        await gate.request(outcome, {
          approvalId,
          evidenceHashes,
          preview: `${intent.action} on ${intent.targetRefs[0]?.id ?? "target"}`,
          riskSummary: `${outcome.risk.level} risk — ${requiredApproverCount(
            outcome.risk.level
          )} approver(s) required`,
          allowedApproverRoles: [APPROVER_ROLE],
          proposerPrincipalId: ROUTINE_PRINCIPAL_ID,
          agentPrincipalId: AGENT_PRINCIPAL_ID,
          expiresAt: new Date(clock + APPROVAL_TTL_MS),
          createdAt: now(),
        });
      }
      walk.steps.push({ state: state.name, status: "awaiting_approval" });
      return {
        outcome: "awaiting_approval",
        deliveryId: walk.deliveryId,
        issueNumber: walk.issueNumber,
        steps: walk.steps,
        citations: walk.citations,
        pendingApprovalId: approvalId,
      };
    }

    try {
      const reserved = await gate.consumeAndReserve({
        businessId: BUSINESS_ID,
        approvalId,
        intent,
        evidenceHashes,
        guardrailRevision: GUARDRAIL_REVISION,
        effect: reserveInputFor(gatedState, walk, intent),
        at: now(),
      });
      walk.preReserved.set(gatedName, {
        effectId: reserved.effect.effectId,
        created: reserved.outcome === "created",
      });
      walk.steps.push({ state: state.name, status: "completed" });
      return undefined;
    } catch (error) {
      walk.steps.push({ state: state.name, status: "failed" });
      return blocked(
        walk,
        error instanceof ToolApprovalGateError ? error.code : "approval_unavailable"
      );
    }
  }

  async function walkRoutine(
    deliveryId: string,
    issueNumber: number,
    mode: "start" | "resume"
  ): Promise<TriageResult> {
    const walk: WalkState = {
      deliveryId,
      issueNumber,
      mode,
      steps: [],
      citations: [],
      outputs: {},
      preReserved: new Map(),
    };

    let current: string | null = compiled.start;
    while (current !== null) {
      const state: CompiledState | undefined = compiled.states.get(current);
      if (state === undefined) throw new Error(`unknown State ${current}`);

      switch (state.type) {
        case "tool": {
          const result = await runToolState(state, walk);
          if ("failure" in result) return result.failure;
          walk.outputs[state.name] = result.output;
          walk.citations.push(...citationsFor(state, result.output));
          break;
        }
        case "agent": {
          walk.outputs[state.name] = classifyIssue(state);
          walk.steps.push({ state: state.name, status: "completed" });
          break;
        }
        case "approval": {
          const paused = await runApprovalState(state, walk);
          if (paused !== undefined) return paused;
          break;
        }
        case "branch": {
          walk.steps.push({ state: state.name, status: "completed" });
          break;
        }
        default:
          throw new Error(`unsupported State type ${state.type}`);
      }

      if (state.name === cancelAfterState) {
        walk.steps.push({ state: state.name, status: "cancelled" });
        return {
          outcome: "cancelled",
          deliveryId,
          issueNumber,
          steps: walk.steps,
          citations: walk.citations,
        };
      }

      current = nextState(state, walk);
    }

    return {
      outcome: "completed",
      deliveryId,
      issueNumber,
      steps: walk.steps,
      citations: walk.citations,
    };
  }

  function nextState(state: CompiledState, walk: WalkState): string | null {
    if (state.type === "branch") {
      const scope = scopeOf(walk);
      for (const arm of state.conditions) {
        if (arm.condition.evaluate(scope) === true) return arm.end ? null : arm.transition;
      }
      return state.defaultEnd ? null : state.defaultTransition;
    }
    return state.end ? null : state.transition;
  }

  // ── Public surface ──────────────────────────────────────────────────────────

  return {
    businessId: BUSINESS_ID,
    github,
    jira,
    effects,
    approvals,
    githubCredential: GITHUB_CREDENTIAL,
    jiraCredential: JIRA_CREDENTIAL,
    get acceptedEvents() {
      return [...acceptedEvents];
    },

    classify(next) {
      classification = next;
    },
    signedDelivery,
    ingest,

    triage(input) {
      return walkRoutine(input.deliveryId, input.issueNumber, "start");
    },
    resume(previous) {
      return walkRoutine(previous.deliveryId, previous.issueNumber, "resume");
    },

    async approve(approvalId, approverIds = ["principal-approver-a", "principal-approver-b"]) {
      for (const principalId of approverIds) {
        await decisions.decide(
          BUSINESS_ID,
          approvalId,
          { principalId, businessId: BUSINESS_ID, roles: [APPROVER_ROLE] },
          "approved",
          now()
        );
      }
    },

    reconcile(effectId) {
      return reconciler.reconcile(BUSINESS_ID, effectId);
    },

    now,
    advanceClock(ms) {
      clock += ms;
    },
    cancelAfter(stateName) {
      cancelAfterState = stateName;
    },
    revokeAccessGrants() {
      githubGrants = [];
      jiraGrants = [];
    },
    revokeAuthorization() {
      authorizationActive = false;
    },
  };
}

export type { SeedIssueInput };
