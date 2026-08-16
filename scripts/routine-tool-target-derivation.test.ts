import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BrokerRoutineToolPort } from "../apps/worker/src/routine/tool-port";
import type { AuthorityLayer } from "../packages/authz/src";
import { compileRoutine } from "../packages/run-kernel/src/routine/compiler";
import { planToolDispatch } from "../packages/run-kernel/src/routine/states/tool";
import type { RuntimeBundle } from "../packages/soul/src";
import { MemoryEffectStore, type ToolAdapter } from "../packages/tool-broker/src";

/**
 * Fitness function for L3-3: a Routine Tool call must reach the authorization gate carrying the
 * object it will touch.
 *
 * `apps/worker/src/routine/tool-port.ts` hardcoded `targetRefs: []`. The gate still failed closed,
 * but it could only decide *whether* the Tool may run, never *which* Record or provider object it
 * may run against — so an operator who wanted a Routine to comment on one issue had to grant it
 * every issue. Unit tests on the broker, the grant matcher and the port all passed throughout,
 * because each one was given targets by its own fixture.
 *
 * These assertions run the production composition instead: the real Routine compiler plans a real
 * `tool` State, the real port authorizes it against a real pinned contract, and a real grant
 * scoped to one object decides the call. A regression that reinstates an empty target list makes
 * the scoped grant stop discriminating, which is what the last two cases here measure.
 */

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();
const TOOL_PORT = join(ROOT, "apps/worker/src/routine/tool-port.ts");

const BUSINESS_ID = "biz-l3-3";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const STATE_NAME = "CommentIssue";

const IDENTITY_CEILING = {
  principalKind: "service",
  principalId: "target-fitness",
  grants: [],
  maxRiskClass: "medium",
} as const;

/** One `tool` State whose arguments name the exact issue the call will comment on. */
const AUTHORED_ROUTINE = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "01J000000000000000000TGT1",
    slug: "target-fitness",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    owner: "platform",
    start: STATE_NAME,
    states: [
      {
        type: "tool",
        name: STATE_NAME,
        toolRef: { name: "github.issue.comment", version: "1.0.0" },
        action: "issue.comment",
        destination: "github",
        input: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: authored Routine expression.
          repository: "${ input.repository }",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: authored Routine expression.
          issueNumber: "${ input.issueNumber }",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: authored Routine expression.
          body: "${ input.body }",
        },
        end: true,
      },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: authored fixture, validated by the compiler.
  } as any,
  // biome-ignore lint/suspicious/noExplicitAny: authored fixture, validated by the compiler.
} as any;

/** The Integration-owned declaration: which argument names the object this operation acts on. */
function toolContract(targets: readonly Record<string, string>[] | undefined) {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: "01J000000000000000000TGT2",
      slug: "github-issue-comment",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: "a".repeat(64),
    },
    spec: {
      toolId: "github.issue.comment",
      toolVersion: "1.0.0",
      action: "issue.comment",
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: { type: "object", additionalProperties: true },
      riskClass: "medium",
      mutating: true,
      requiredResources: targets === undefined ? [] : ["github.issue"],
      dataClasses: ["source-content"],
      allowedDestinations: ["github"],
      idempotency: { strategy: "provider" },
      dryRun: false,
      adapter: { kind: "integration", ref: "github" },
      ...(targets === undefined ? {} : { targets }),
    },
  };
}

const GUARDRAIL = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Guardrail",
  metadata: {
    id: "01J000000000000000000TGT3",
    slug: "target-fitness",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    defaultDecision: "deny",
    rules: [
      {
        id: "allow-comment",
        type: "allow",
        actions: ["issue.comment"],
        dataClasses: ["source-content"],
        destinations: ["github"],
      },
    ],
  },
};

function bundle(documents: readonly { kind: string; document: unknown }[]): RuntimeBundle {
  const definitions = documents.map((entry, index) => ({
    kind: entry.kind,
    id: `def-${index}`,
    slug: `def-${index}`,
    authoredVersion: 1,
    hash: "b".repeat(64),
    document: entry.document,
    references: [],
  }));

  return {
    digest: "c".repeat(64),
    businessId: BUSINESS_ID,
    changesetId: "changeset-1",
    commitSha: "d".repeat(40),
    definitions,
    assets: [],
    get: (kind: string, slug: string) =>
      definitions.find((entry) => entry.kind === kind && entry.slug === slug),
    getById: (id: string) => definitions.find((entry) => entry.id === id),
    asset: () => undefined,
  } as unknown as RuntimeBundle;
}

/** Plans the State the way the Routine executor does, from the compiler's own output. */
function planFor(input: Record<string, unknown>) {
  const compiled = compileRoutine(AUTHORED_ROUTINE, { identityCeiling: IDENTITY_CEILING });
  const state = compiled.states.get(STATE_NAME);
  if (state === undefined) throw new Error(`${STATE_NAME} missing from compiled Routine`);
  return planToolDispatch(
    state,
    { input },
    {
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateKey: STATE_NAME,
    }
  );
}

const ISSUE_INPUT = { repository: "tulip/farm", issueNumber: 42, body: "on it" };

const DECLARED_TARGETS = [{ type: "github.issue", id: "{repository}#{issueNumber}" }];

/** Grants only what the State names, which is only expressible once a target reaches the gate. */
function grantFor(recordSelector: string): readonly AuthorityLayer[] {
  return [
    {
      name: "operator",
      grants: [
        { action: "issue.comment", resourceType: "github.issue", recordSelector, effect: "allow" },
      ],
    },
  ];
}

async function run(options: {
  readonly input?: Record<string, unknown>;
  readonly untargeted?: boolean;
  readonly authorityLayers?: readonly AuthorityLayer[];
}) {
  const effects = new MemoryEffectStore();
  const dispatch = vi.fn<ToolAdapter["dispatch"]>(async () => ({ commentId: 7 }));
  const port = new BrokerRoutineToolPort({
    effects,
    adapters: new Map<string, ToolAdapter>([["github", { kind: "integration", dispatch }]]),
  });
  const plan = planFor(options.input ?? ISSUE_INPUT);

  const outcome = await port.execute({
    businessId: BUSINESS_ID,
    runId: RUN_ID,
    stateKey: STATE_NAME,
    plan,
    bundle: bundle([
      {
        kind: "ToolContract",
        document: toolContract(options.untargeted === true ? undefined : DECLARED_TARGETS),
      },
      { kind: "Guardrail", document: GUARDRAIL },
    ]),
    authorityLayers:
      options.authorityLayers ?? grantFor(`${ISSUE_INPUT.repository}#${ISSUE_INPUT.issueNumber}`),
  });

  return { outcome, dispatch, effect: await effects.get(BUSINESS_ID, plan.effectId) };
}

describe("Routine Tool intents carry the object they act on (L3-3)", () => {
  it("no longer hardcodes an empty target list at the port", () => {
    const source = readFileSync(TOOL_PORT, "utf8");
    expect(source).not.toMatch(/targetRefs:\s*\[\s*\]/);
    expect(source).toContain("deriveContractTargets");
  });

  it("derives the target from the contract and carries it to the adapter and the ledger", async () => {
    const { outcome, dispatch, effect } = await run({});

    expect(outcome).toEqual({ kind: "succeeded" });
    const expected = [{ type: "github.issue", id: "tulip/farm#42" }];
    expect(dispatch.mock.calls[0]?.[0].intent.targetRefs).toEqual(expected);
    expect(effect?.intent.targetRefs).toEqual(expected);
  });

  it("lets a grant scoped to one object authorize that object and refuse another", async () => {
    const allowed = await run({ authorityLayers: grantFor("tulip/farm#42") });
    const refused = await run({ authorityLayers: grantFor("tulip/farm#43") });

    // The whole point of L3-3: these two must differ. With `targetRefs: []` they cannot.
    expect(allowed.outcome).toEqual({ kind: "succeeded" });
    expect(refused.outcome).toEqual({ kind: "failed", reason: "authorization_denied" });
    expect(refused.dispatch).not.toHaveBeenCalled();
    expect(refused.effect).toBeUndefined();
  });

  it("refuses, rather than widens, when the arguments name no target the contract declares", async () => {
    // Resolves as an input mapping, so planning succeeds — but an object is not an object *id*.
    const { outcome, dispatch, effect } = await run({
      input: { repository: "tulip/farm", issueNumber: { number: 42 }, body: "on it" },
    });

    expect(outcome).toEqual({ kind: "failed", reason: "target_unresolved" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(effect).toBeUndefined();
  });

  it("keeps the Tool-granular decision for a contract that declares no target at all", async () => {
    const { outcome, dispatch } = await run({
      untargeted: true,
      authorityLayers: [
        {
          name: "operator",
          grants: [
            {
              action: "issue.comment",
              resourceType: "Tool",
              recordSelector: "github.issue.comment",
              effect: "allow",
            },
          ],
        },
      ],
    });

    expect(outcome).toEqual({ kind: "succeeded" });
    expect(dispatch.mock.calls[0]?.[0].intent.targetRefs).toEqual([]);
  });
});
