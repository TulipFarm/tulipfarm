/**
 * The L3 tier: one Chat Turn, executed by the product's own Chat executor.
 *
 * L2 drives the Agent loop directly. That proves the Context assembler, the Tool loop and the
 * guards, and it is where nearly all the signal is. What it cannot prove is everything the loop is
 * wrapped in — that the Run reaches a terminal status, that its State transitions are legal, that
 * its budgets are debited before the work, that its Run events are durable and ordered, and that
 * the Turn is completed exactly once. L3 exists for those, and for nothing else: it runs a handful
 * of Cases, not the Corpus.
 *
 * The Turn is minted with `RunStore.start` rather than through the API's invocation gateway, which
 * needs the Artifact store and request validator `apps/api` owns and this app may not import. What
 * the executor reads back out — the Run, its `invoke` State, its budgets — is real.
 */

import { randomUUID } from "node:crypto";
import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import { INVOKE_STATE_KEY } from "@tulipfarm/run-kernel";
import type { PersistedRun } from "@tulipfarm/storage";
import {
  type ApprovalWaitPort,
  createChatExecutor,
  RunStoreStateTransitions,
} from "@tulipfarm/turn-executor";
import type { EvalCase } from "../case.ts";
import type { EvalSoul } from "../eval-soul.ts";
import { type ModelBinding, toolDispatcher } from "../runner.ts";
import { evalTurnContext } from "./context.ts";
import { type EvalDatabase, openEvalDatabase } from "./database.ts";
import {
  SOUL_WRITE_TOOL,
  type SoulCommit,
  type SoulWriterTool,
  soulWriterTool,
} from "./soul-write.ts";
import { evalTurnHost } from "./turn-host.ts";

const BUSINESS_ID = "eval";

/**
 * No Case waits on an approval, and one that did would hang rather than fail.
 *
 * Registering a wait the tier never signals would leave the Run parked and the Trial would time
 * out with no verdict, so this refuses loudly instead. Approvals are a Tool-broker concern the L2
 * tier already covers through the guard path.
 */
const NO_APPROVALS: ApprovalWaitPort = {
  register: async () => {
    throw new Error("the L3 tier does not run approval waits; use an L2 guardrail Case");
  },
};

/** What one L3 Trial persisted, as a Case may assert on it. */
export interface PersistedTurn {
  /** The Run's terminal status, as the Run kernel recorded it. */
  readonly runStatus: string;
  /** The `invoke` State's terminal status. */
  readonly stateStatus: string;
  /** Whether the Turn was completed, and how. */
  readonly turnStatus: string | null;
  /** The assistant Message the Turn appended, if it appended one. */
  readonly answer: string | null;
  /** Run event types in the order they were appended. */
  readonly events: readonly string[];
  /** Tool names the Turn actually dispatched. */
  readonly toolCalls: readonly string[];
  /** Commits the Turn landed in the Eval Soul's real git repository. */
  readonly soulCommits: readonly SoulCommit[];
  /** The prompt the real Context assembler produced, so `prompt_contains` works at L3 too. */
  readonly systemPrompt: string;
}

export interface L3Options {
  readonly evalCase: EvalCase;
  readonly soul: EvalSoul;
  readonly binding: ModelBinding;
  /** Which Turn of a journey this is; a later Turn reuses the database and Soul of the first. */
  readonly turn?: number;
  /** Overridden only by tests that need to inspect the database afterwards. */
  readonly database?: EvalDatabase;
}

async function mintRun(database: EvalDatabase, runId: string, turnId: string): Promise<void> {
  const createdAt = new Date().toISOString();
  await database.runs.start({
    id: runId,
    businessId: BUSINESS_ID,
    source: "chat",
    bundle: { digest: "sha256:eval", routineId: "chat", routineVersion: "eval" },
    identity: {
      initiator: { kind: "user", id: "eval" },
      effectiveSubject: { kind: "agent", id: "eval" },
      guardrailContextRef: "eval",
    },
    createdAt,
    states: [
      {
        key: INVOKE_STATE_KEY,
        definitionRef: "published:chat:eval",
        resolvedInput: { turnId },
      },
    ],
  });
}

/**
 * Sends a Soul write to the real writer and everything else to the Case's script.
 *
 * Routing by name rather than merging keeps the two honest: a Case cannot accidentally script a
 * result for `soul_write` and have the tier report a commit that never happened.
 */
function routeTools(scripted: ToolDispatchPort, soulWrites: ToolDispatchPort): ToolDispatchPort {
  return {
    dispatch: (request) =>
      request.name === SOUL_WRITE_TOOL ? soulWrites.dispatch(request) : scripted.dispatch(request),
  };
}

async function readBack(
  database: EvalDatabase,
  runId: string,
  turnId: string,
  observed: {
    toolCalls: readonly string[];
    soulCommits: readonly SoulCommit[];
    systemPrompt: string;
  }
): Promise<PersistedTurn> {
  const run = await database.runs.find(BUSINESS_ID, runId);
  const state = await database.runs.findState(BUSINESS_ID, runId, INVOKE_STATE_KEY);
  const turn = await database.query(
    "SELECT status, message_id FROM eval_turns WHERE business_id = $1 AND turn_id = $2",
    [BUSINESS_ID, turnId]
  );
  const message = await database.query(
    "SELECT content FROM eval_messages WHERE business_id = $1 AND turn_id = $2 ORDER BY seq",
    [BUSINESS_ID, turnId]
  );
  const events = await database.query(
    "SELECT event_type FROM run_events WHERE business_id = $1 AND run_id = $2 ORDER BY sequence",
    [BUSINESS_ID, runId]
  );

  const turnRow = turn.rows[0];
  return {
    runStatus: run?.status ?? "missing",
    stateStatus: state?.status ?? "missing",
    turnStatus:
      turnRow?.status === undefined || turnRow.status === null ? null : String(turnRow.status),
    answer: message.rows[0] === undefined ? null : String(message.rows[0].content),
    events: events.rows.map((row) => String(row.event_type)),
    toolCalls: observed.toolCalls,
    soulCommits: observed.soulCommits,
    systemPrompt: observed.systemPrompt,
  };
}

/**
 * Runs one Case through the real Chat executor and reports what it persisted.
 *
 * The Run is dispatched synchronously rather than through pg-boss: a queue would add a poll loop
 * and a second process to a tier whose whole job is one Turn, and the executor is the same function
 * the Worker's job handler calls either way.
 */
export async function runPersistedTurn(options: L3Options): Promise<PersistedTurn> {
  const database = options.database ?? (await openEvalDatabase());
  const owned = options.database === undefined;
  const runId = randomUUID();
  const turnId = randomUUID();
  const conversationId = randomUUID();
  let soulWrites: SoulWriterTool | undefined;

  try {
    await mintRun(database, runId, turnId);
    await database.query(
      `INSERT INTO eval_turns (business_id, run_id, turn_id, conversation_id, attempt)
       VALUES ($1, $2, $3, $4, 1)`,
      [BUSINESS_ID, runId, turnId, conversationId]
    );

    const scripted = toolDispatcher(options.evalCase);
    soulWrites = soulWriterTool(options.soul);
    const tools = routeTools(scripted.port, soulWrites.port);
    const host = evalTurnHost(database);
    const context = evalTurnContext({ evalCase: options.evalCase, soul: options.soul });
    const executor = createChatExecutor({
      host: { ...host, dispatch: tools.dispatch },
      context,
      runs: database.runs,
      events: database.events,
      budgets: database.budgets,
      transitions: new RunStoreStateTransitions(database.runs),
      waits: NO_APPROVALS,
      model: options.binding.create(options.evalCase),
      log: { warn: () => {} },
    });

    const run = await database.runs.find(BUSINESS_ID, runId);
    if (run === null) throw new Error(`L3 minted Run ${runId} but could not read it back`);
    const outcome = await executor(run as PersistedRun);
    // The Worker records the executor's verdict on the Run; without it every L3 Trial would read
    // back `queued` and the Run-status Expectation would measure the tier's own omission.
    const settled = await database.runs.find(BUSINESS_ID, runId);
    await database.runs.transitionRun(BUSINESS_ID, runId, {
      expectedVersion: settled?.version ?? run.version,
      expectedStatus: settled?.status ?? run.status,
      status: outcome,
      finishedAt: new Date().toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    return await readBack(database, runId, turnId, {
      toolCalls: scripted.calls.map((call) => call.name),
      soulCommits: soulWrites.commits,
      systemPrompt: context.systemPrompt,
    });
  } finally {
    // Before the database, because a Soul left dirty contaminates the next Trial in a way a fresh
    // database cannot undo: the Soul is loaded once per Sweep and shared.
    soulWrites?.reset();
    if (owned) await database.close();
  }
}
