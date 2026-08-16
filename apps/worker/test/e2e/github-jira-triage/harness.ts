import { requiredApproverCount } from "@tulipfarm/authz";
import { type CompiledState, compileRoutine } from "@tulipfarm/run-kernel";
import {
  type AccessGrantDefinition,
  DEFINITION_REGISTRATIONS,
  routine as routineSchema,
  SchemaRegistry,
} from "@tulipfarm/schema";
import { SecretLeaseDeniedError } from "@tulipfarm/secrets";
import type { InMemoryApprovalRepo } from "@tulipfarm/storage";
import {
  AdapterDispatchError,
  type MemoryEffectStore,
  type ReconciliationResult,
  ToolApprovalGateError,
  type ToolIntent,
} from "@tulipfarm/tool-broker";
import { classifyIssue } from "./agent-stub";
import {
  AGENT_PRINCIPAL_ID,
  APPROVAL_TTL_MS,
  APPROVER_ROLE,
  AUTHORITY_LAYERS,
  accessGrant,
  authoredString,
  BUSINESS_ID,
  type DeliveryInput,
  DLP_RULES,
  GITHUB_CREDENTIAL,
  GITHUB_SECRET_REF,
  GUARDRAIL_REVISION,
  GUARDRAIL_RULES,
  IDENTITY_CEILING,
  type IngressResult,
  JIRA_CREDENTIAL,
  ROUTINE_PRINCIPAL_ID,
  readDefinition,
  type TriageClassification,
  type TriageResult,
  type TriageStepStatus,
  toolRefOf,
} from "./fixtures";
import { createTriageIngress } from "./ingress";
import type { GitHubProvider, JiraProvider, SeedIssueInput, SignedDelivery } from "./providers";
import {
  blocked,
  citationsFor,
  effectIdFor,
  inputsFor,
  providerOutputFor,
  reserveInputFor,
  scopeOf,
  type WalkState,
} from "./walk";
import { createTriageWiring } from "./wiring";

/** Real governed triage wiring; reads skip the ledger, mutations reserve, resumes replay. */

/** Agent outputs account ids, not GitHub logins, so prompt text cannot pick assignees. */
const _DIRECTORY: Readonly<Record<string, string>> = {
  "acct-maya": "maya-dev",
  "acct-lee": "lee-dev",
};

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

  function requireClassification(): TriageClassification {
    if (classification === undefined) throw new Error("no classification stub configured");
    return classification;
  }

  const now = (): Date => new Date(clock);
  const nowIso = (): string => new Date(clock).toISOString();

  const {
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
  } = createTriageWiring({
    clock: () => clock,
    githubGrants: () => githubGrants,
    jiraGrants: () => jiraGrants,
    authorized: () => authorizationActive,
  });

  const { acceptedEvents, ingest, signedDelivery } = createTriageIngress(github);

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
      // Deterministic per delivery and State so redelivery/retry/resume share one effect.
      idempotencyKey: `${BUSINESS_ID}:${deliveryId}:${state.name}`,
    };
  }

  function secretRefOf(intent: ToolIntent): string {
    return intent.credentialRef ?? GITHUB_SECRET_REF;
  }

  /** Reads skip the ledger because they create no external effect. */
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
              ...reserveInputFor(state, walk, intent, nowIso()),
              intent,
              intentDigest: outcomeDigest(intent),
              guardrailRevision: GUARDRAIL_REVISION,
            })
          ).outcome === "created";

    if (!created) {
      const effect = await effects.get(BUSINESS_ID, effectId);
      const replayed =
        effect?.state === "confirmed" ? providerOutputFor({ github, jira }, effect) : undefined;
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

  /** Start raises approval; resume spends it and reserves the gated effect atomically. */
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

    // Resume may raise a missing approval; only existing approvals are spent.
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
        effect: reserveInputFor(gatedState, walk, intent, nowIso()),
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
          walk.outputs[state.name] = classifyIssue(requireClassification(), state);
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
