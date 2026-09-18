import * as integrations from "@tulipfarm/integrations";
import { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import { MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../case.ts";
import { loadCorpus } from "../corpus.ts";
import { type EvalSoul, loadEvalSoul } from "../eval-soul.ts";
import { runSweep } from "../runner.ts";
import { scoreCase } from "../scorer.ts";
import { scriptedBinding } from "../scripted.ts";
import { runPersistedTurn } from "./tier.ts";

let soul: EvalSoul;
let cases: readonly EvalCase[];
const CORPUS_DIR = path.join(__dirname, "../../corpus");

beforeAll(async () => {
  soul = await loadEvalSoul();
  cases = (await loadCorpus(CORPUS_DIR, soul)).cases;
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => soul.dispose());

function nativeCase(id: string) {
  const result = cases.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`Missing native admission Case ${id}`);
  return result;
}

async function observe(id: string) {
  const evalCase = nativeCase(id);
  const turn = await runPersistedTurn({ evalCase, soul, binding: scriptedBinding() });
  const expectations = scoreCase(evalCase.expect, {
    systemPrompt: turn.systemPrompt,
    output: undefined,
    status: turn.runStatus,
    toolCalls: turn.toolCalls,
    guardrails: turn.guardrails,
    persisted: turn,
  });
  return { turn, expectations };
}

describe("native Routine admission Corpus", () => {
  it.each([
    "l3-native-routine-approved-route-account",
    "l3-native-routine-lost-inbox-lease-rolls-back",
    "l3-native-routine-changed-route-denied",
    "l3-native-routine-revoked-account-denied",
  ])(
    "observes real admission for %s",
    async (id) => {
      const { expectations } = await observe(id);
      expect(expectations.filter((result) => !result.passed)).toEqual([]);
    },
    60_000
  );

  it("scores native admission through the Sweep path used by the CLI", async () => {
    const scorecard = await runSweep({
      corpus: await loadCorpus(CORPUS_DIR, soul),
      model: scriptedBinding(),
      caseFilter: "l3-native-routine-approved-route-account",
    });
    expect(scorecard.trials).toHaveLength(1);
    expect(scorecard.trials[0]?.passed).toBe(true);
  }, 60_000);

  it("fails if the production gateway loses persisted identity evidence", async () => {
    const start = DurableInvocationGateway.prototype.start;
    vi.spyOn(DurableInvocationGateway.prototype, "start").mockImplementation(function (
      this: DurableInvocationGateway,
      input,
      transaction
    ) {
      return start.call(this, { ...input, identityMappingEvidenceRef: undefined }, transaction);
    });
    const { turn, expectations } = await observe("l3-native-routine-approved-route-account");
    expect(turn.nativeAdmission).toMatchObject({ runCount: 0, error: "identity_substitution" });
    expect(expectations.some((result) => !result.passed)).toBe(true);
  }, 60_000);

  it("catches the old nontransactional start-then-bind orphan Run", async () => {
    vi.spyOn(integrations, "admitNativeRoutine").mockImplementation(async (event, deps) => {
      const [route] = await deps.inbox.routineRoutes(event.businessId, event.provider);
      if (
        !route ||
        !deps.authorizeRoutine ||
        !(deps.invocations instanceof DurableInvocationGateway)
      ) {
        throw new Error("The regression probe needs real native admission dependencies.");
      }
      const authority = await deps.authorizeRoutine(route);
      await deps.inbox.assertClaim(event);
      const result = await deps.invocations.start({
        source: "integration",
        runSource: "routine",
        businessId: event.businessId,
        initiator: { kind: "integration", id: event.integrationId },
        effectiveSubject: authority.principal,
        identityMappingEvidenceRef: `native-channel-inbox:${event.id}`,
        definitionRef: authority.definitionRef,
        payload: {
          slug: authority.definitionRef.slice("published:routine:".length),
          inputs: {
            event: event.payload,
            nativeChannel: {
              provider: event.provider,
              integrationId: event.integrationId,
              destination: route.destination,
              eventType: route.eventType,
            },
          },
        },
        payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
        idempotencyKey: `native:${event.id}`,
      });
      await deps.inbox.bindRun(event, result.runId);
      return result.runId;
    });
    const { turn, expectations } = await observe("l3-native-routine-lost-inbox-lease-rolls-back");
    expect(turn.nativeAdmission).toMatchObject({
      runCount: 1,
      artifactCount: 1,
      invocationCount: 1,
      stateCount: 1,
      inboxRunId: null,
      error: "native_delivery_lease_lost",
    });
    expect(expectations.some((result) => !result.passed)).toBe(true);
  }, 60_000);
});

import path from "node:path";
