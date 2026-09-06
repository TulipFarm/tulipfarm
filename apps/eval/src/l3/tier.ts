import { contentText, type MessageContent, normalizeMessageContent } from "@tulipfarm/schema";
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
import {
  ModelInvocationError,
  type ModelMessage,
  type ModelUsage,
  type ToolDispatchPort,
} from "@tulipfarm/agent-runtime";
import { soulDigest, soulSubjects, soulSummary } from "@tulipfarm/curator";
import { CuratorHost, CuratorTaskDelivery } from "@tulipfarm/curator-host";
import { INVOKE_STATE_KEY } from "@tulipfarm/run-kernel";
import { CuratorRepo, type PersistedRun, TaskRepo } from "@tulipfarm/storage";
import {
  createChatExecutor,
  RunStoreStateTransitions,
  type TurnWaitPort,
} from "@tulipfarm/turn-executor";
import type { EvalCase, JourneyTurn } from "../case.ts";
import { toolDispatcher } from "../dispatch.ts";
import type { EvalSoul } from "../eval-soul.ts";
import type { ModelBinding } from "../runner.ts";
import { addSpend, mergeSpend, NO_SPEND, type Spend } from "../spend.ts";
import { evalTurnContext } from "./context.ts";
import { type EvalDatabase, openEvalDatabase } from "./database.ts";
import { type DoctorEvent, runDoctor } from "./doctor.ts";
import {
  type EvalFileStore,
  evalFileStore,
  FILE_CREATE_TOOL,
  type GeneratedFile,
  seedAgentRoles,
} from "./file-store.ts";
import {
  SOUL_WRITE_TOOL,
  type SoulCommit,
  type SoulWriterTool,
  soulWriterTool,
} from "./soul-write.ts";
import { evalTurnHost } from "./turn-host.ts";

const BUSINESS_ID = "eval";
/** The person every L3 Turn runs for, and so the one reader a generated File always has. */
const PARTICIPANT_ID = "eval";
const CURATOR_TURN_ID = "eval-curator-turn";

/** One dispatched Tool call, as a Case's Tool Expectations read it. */
export interface ToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

/**
 * No Case waits on an approval, and one that did would hang rather than fail.
 *
 * Registering a wait the tier never signals would leave the Run parked and the Trial would time
 * out with no verdict, so this refuses loudly instead. Approvals are a Tool-broker concern the L2
 * tier already covers through the guard path.
 */
const NO_APPROVALS: TurnWaitPort = {
  register: async () => {
    throw new Error("the L3 tier does not run approval waits; use an L2 guardrail Case");
  },
  // No Run here ever parks on a child, so there is never a resolution to claim.
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
  /** Every Tool the Turn dispatched, in order, with the arguments it was called with. */
  readonly toolCalls: readonly ToolCall[];
  /** Commits the Turn landed in the Eval Soul's real git repository. */
  readonly soulCommits: readonly SoulCommit[];
  /** Artifacts the active Soul publication serves once the Turn settled, written `Kind:slug`. */
  readonly publishedArtifacts: readonly string[];
  /** Files the Turn generated, each with the audience `FileService` gave it. */
  readonly generatedFiles: readonly GeneratedFile[];
  /** Tasks the Curator delivered after this Turn completed. */
  readonly curatorTasks?: readonly { readonly title: string }[];
  /** What the Soul Doctor's sweep did to the Soul this Turn left behind. */
  readonly doctorEvents?: readonly DoctorEvent[];
  /** Real Tool dispatches this Turn's writer denied, with the exact reason it gave back. */
  readonly toolDenials: readonly { readonly name: string; readonly reason: string }[];
  /** The prompt the real Context assembler produced, so `prompt_contains` works at L3 too. */
  readonly systemPrompt: string;
  /**
   * What the Turn billed the seat.
   *
   * Recorded rather than assumed zero: an L3 Trial calls the same paid vendor an L2 Trial does, and
   * a journey calls it once per Turn. Reported as `NO_SPEND` it would be invisible to
   * `ceilingReached`, so the one ceiling that can bound a subscription seat — tokens — would not
   * bound the most expensive tier in the framework.
   */
  readonly spend: Spend;
}

export interface L3Options {
  readonly evalCase: EvalCase;
  readonly soul: EvalSoul;
  readonly binding: ModelBinding;
  /** Which Turn of a journey this is; a later Turn reuses the database and Soul of the first. */
  readonly turn?: number;
  /** Overridden only by tests that need to inspect the database afterwards. */
  readonly database?: EvalDatabase;
  /**
   * Called with each model call's usage as it happens, mirroring L2's `attemptUsage`.
   *
   * The returned `spend` is enough for a Turn that completes, but a Turn that throws half way has
   * still billed the seat. Reporting that as zero would let a Case that crashes late spend real
   * quota invisibly, so the caller is told per call rather than only at the end.
   */
  readonly onUsage?: (usage: ModelUsage) => void;
}

async function mintRun(database: EvalDatabase, runId: string, turnId: string): Promise<void> {
  const createdAt = new Date().toISOString();
  await database.runs.start({
    id: runId,
    businessId: BUSINESS_ID,
    source: "chat",
    bundle: { digest: "sha256:eval", routineId: "chat", routineVersion: "eval" },
    identity: {
      initiator: { kind: "user", id: PARTICIPANT_ID },
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
 * Sends the two real Tools to the real implementations and everything else to the Case's script.
 *
 * Routing by name rather than merging keeps them honest: a Case cannot accidentally script a
 * result for `soul_write` and have the tier report a commit that never happened, nor script one
 * for `file_create` and have it report an audience nothing granted.
 */
function routeTools(
  scripted: { port: ToolDispatchPort; calls: ToolCall[] },
  real: Readonly<Record<string, ToolDispatchPort>>
): ToolDispatchPort {
  return {
    dispatch: (request) => {
      const port = real[request.name];
      if (port === undefined) return scripted.port.dispatch(request);
      // Recorded into the same log the scripted dispatcher keeps. Without this a Soul write is
      // invisible to the scorer, and `tool_not_called soul_write` — the natural way to assert an
      // agent must not reconfigure the business — passes even as the commit lands.
      scripted.calls.push({ name: request.name, arguments: request.arguments });
      return port.dispatch(request);
    },
  };
}

async function readBack(
  database: EvalDatabase,
  runId: string,
  turnId: string,
  observed: {
    toolCalls: readonly ToolCall[];
    soulCommits: readonly SoulCommit[];
    publishedArtifacts: readonly string[];
    generatedFiles: readonly GeneratedFile[];
    curatorTasks: readonly { readonly title: string }[];
    doctorEvents: readonly DoctorEvent[];
    toolDenials: readonly { readonly name: string; readonly reason: string }[];
    systemPrompt: string;
    spend: Spend;
  }
): Promise<PersistedTurn> {
  const run = await database.runs.find(BUSINESS_ID, runId);
  const state = await database.runs.findState(BUSINESS_ID, runId, INVOKE_STATE_KEY);
  const turn = await database.query(
    "SELECT status, message_id FROM eval_turns WHERE business_id = $1 AND turn_id = $2",
    [BUSINESS_ID, turnId]
  );
  const message = await database.query(
    `SELECT content FROM eval_messages
     WHERE business_id = $1 AND turn_id = $2 AND role = 'assistant' ORDER BY seq`,
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
    answer:
      message.rows[0] === undefined ? null : contentText(decodeContent(message.rows[0].content)),
    events: events.rows.map((row) => String(row.event_type)),
    spend: observed.spend,
    toolCalls: observed.toolCalls,
    soulCommits: observed.soulCommits,
    publishedArtifacts: observed.publishedArtifacts,
    generatedFiles: observed.generatedFiles,
    curatorTasks: observed.curatorTasks,
    doctorEvents: observed.doctorEvents,
    toolDenials: observed.toolDenials,
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
async function runOneTurn(
  options: L3Options,
  shared: {
    database: EvalDatabase;
    conversationId: string;
    soul: EvalSoul;
    soulWrites: SoulWriterTool;
    files: EvalFileStore;
    /**
     * The Run the File store should stamp on what this Turn generates.
     *
     * A box rather than a parameter because the store outlives one Turn — it is shared across a
     * journey — while the Run does not, and a store built once against the first Run would record
     * every later Turn's File as having come from a Run that did not write it.
     */
    activeRun: { id: string };
    /** What this Turn newly submits, as distinct from the history it was handed. */
    submit: readonly ModelMessage[];
  }
): Promise<PersistedTurn> {
  const { database, conversationId, soul, soulWrites, files } = shared;
  const runId = randomUUID();
  const turnId = randomUUID();
  shared.activeRun.id = runId;
  {
    await mintRun(database, runId, turnId);
    await database.query(
      `INSERT INTO eval_turns (business_id, run_id, turn_id, conversation_id, attempt)
       VALUES ($1, $2, $3, $4, 1)`,
      [BUSINESS_ID, runId, turnId, conversationId]
    );
    // The product writes the participant's Message when the Turn is submitted, not when it is
    // executed. Mirrored here so a journey's later Turn reads back a two-sided Conversation.
    for (const [index, message] of shared.submit.entries()) {
      await database.query(
        `INSERT INTO eval_messages
           (id, business_id, conversation_id, turn_id, attempt, role, content)
         VALUES ($1, $2, $3, $4, 1, $5, $6)`,
        [
          `msg-${turnId}-in-${index}`,
          BUSINESS_ID,
          conversationId,
          turnId,
          message.role,
          JSON.stringify(message.content),
        ]
      );
    }

    const scripted = toolDispatcher(options.evalCase);
    // The writer is shared across a journey so its reset restores the pre-journey commit, which
    // means its `commits` accumulate. Only this Turn's slice belongs to this Turn.
    const committedBefore = soulWrites.commits.length;
    const deniedBefore = soulWrites.denials.length;
    // The File store is shared across a journey for the same reason, so its `generated` accumulate
    // and only this Turn's slice belongs to this Turn.
    const generatedBefore = files.generated.length;
    const tools = routeTools(scripted, {
      [SOUL_WRITE_TOOL]: soulWrites.port,
      [FILE_CREATE_TOOL]: files.port,
    });
    // Wrapped rather than passed straight through: the executor owns the call loop, so this is the
    // only seam where an L3 Turn's usage can be observed at all.
    let spend = NO_SPEND;
    const port = options.binding.create(options.evalCase);
    const metered = {
      invoke: async (request: Parameters<typeof port.invoke>[0]) => {
        if (options.evalCase.fault === "model") {
          throw new ModelInvocationError(
            "model_not_configured",
            new Error(`eval fault: Model is unavailable for Case ${options.evalCase.id}`)
          );
        }
        const result = await port.invoke(request);
        spend = addSpend(spend, result.usage);
        options.onUsage?.(result.usage);
        return result;
      },
    };

    const host = evalTurnHost(database);
    const context = evalTurnContext({ evalCase: options.evalCase, soul });
    const executor = createChatExecutor({
      host: { ...host, dispatch: tools.dispatch },
      context,
      runs: database.runs,
      events: database.events,
      budgets: database.budgets,
      transitions: new RunStoreStateTransitions(database.runs),
      waits: NO_APPROVALS,
      model: metered,
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
      status: outcome.status,
      finishedAt: new Date().toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(outcome.errorEvidenceRef === undefined
        ? {}
        : { errorEvidenceRef: outcome.errorEvidenceRef }),
    });

    const doctorEvents =
      options.evalCase.doctor === undefined
        ? []
        : await runDoctor({ soul, writes: soulWrites, fixture: options.evalCase.doctor });

    const curatorTasks = await deliverCurator({
      database,
      soul,
      evalCase: options.evalCase,
      input: shared.submit,
    });

    return await readBack(database, runId, turnId, {
      toolCalls: [...scripted.calls],
      soulCommits: soulWrites.commits.slice(committedBefore),
      publishedArtifacts: await soulWrites.published(),
      generatedFiles: files.generated.slice(generatedBefore),
      curatorTasks,
      doctorEvents,
      toolDenials: soulWrites.denials
        .slice(deniedBefore)
        .map((reason) => ({ name: SOUL_WRITE_TOOL, reason })),
      systemPrompt: context.systemPrompt,
      spend,
    });
  }
}

async function deliverCurator(input: {
  readonly database: EvalDatabase;
  readonly soul: EvalSoul;
  readonly evalCase: EvalCase;
  readonly input: readonly ModelMessage[];
}): Promise<readonly { readonly title: string }[]> {
  if (input.evalCase.curator === undefined) return [];

  const repo = new CuratorRepo(input.database.queryable);
  const tasks = new TaskRepo(input.database.transactions);
  const job = await repo.insertJob(input.database.queryable, {
    businessId: BUSINESS_ID,
    scope: "user",
    userId: PARTICIPANT_ID,
    state: "running",
    executionMode: "shadow",
    manifestDigest: CURATOR_TURN_ID,
    manifest: { work: [], turnIds: [CURATOR_TURN_ID], candidateIds: [] },
  });
  if (!job) throw new Error("Eval Curator job did not mint");

  const turns = input.input
    .filter((message) => message.role === "user")
    .map((message) => ({ turnId: CURATOR_TURN_ID, userText: contentText(message.content) }));
  const host = new CuratorHost({
    repo,
    documents: { read: async () => null } as never,
    turns: { read: async () => turns },
    subjects: () => soulSubjects(input.soul.loader),
    openProposalKeys: async (businessId, userId) =>
      (await tasks.listForPrincipal(businessId, userId, [], true)).map((task) => task.dedupeKey),
    soulDigest: () => soulDigest(input.soul.loader),
    soulSummary: () => soulSummary(input.soul.loader),
  });
  const context = await host.context(BUSINESS_ID, job.id);
  const contextDigest = context.contextDigest;
  if (typeof contextDigest !== "string") throw new Error("Eval Curator context has no digest");
  await host.submit(BUSINESS_ID, job.id, contextDigest, input.evalCase.curator.output);
  await new CuratorTaskDelivery({ repo, tasks, now: () => new Date() }).run(BUSINESS_ID);
  return (await tasks.listForPrincipal(BUSINESS_ID, PARTICIPANT_ID, [], false)).map((task) => ({
    title: task.title,
  }));
}

/**
 * Reads the Conversation back as model messages, so a later Turn sees what an earlier one said.
 *
 * The history is re-read from the database rather than accumulated in memory. Holding it in a
 * variable would let a journey pass while the Turn persisted nothing at all, which is the exact
 * failure a journey exists to detect.
 */
async function priorMessages(
  database: EvalDatabase,
  conversationId: string
): Promise<readonly ModelMessage[]> {
  const rows = await database.query(
    `SELECT role, content FROM eval_messages
     WHERE business_id = $1 AND conversation_id = $2 ORDER BY seq`,
    [BUSINESS_ID, conversationId]
  );
  return rows.rows.map((row) => ({
    role: String(row.role) as ModelMessage["role"],
    content: decodeContent(row.content),
  }));
}

/**
 * Reads a stored Message back into parts.
 *
 * Both writers store the part array, so this never has to guess from the payload's shape — a reply
 * whose text is itself a JSON array would otherwise decode as parts and lose its content.
 */
function decodeContent(raw: unknown): MessageContent {
  return normalizeMessageContent(JSON.parse(String(raw)));
}

/**
 * Folds a journey's Turns into the one shape a Case scores against.
 *
 * Tool calls, Soul commits and Run events accumulate, because a Case asserting "the artifact was
 * committed" does not care which Turn committed it. Everything else is the last Turn's — except a
 * non-terminal Run status, which is reported from the first Turn that failed. Taking the last
 * would let a journey whose opening Turn died report success.
 */
export function foldJourney(turns: readonly PersistedTurn[]): PersistedTurn {
  const last = turns[turns.length - 1];
  if (last === undefined) throw new Error("a journey ran no Turns");
  // Each status is folded independently. Sourcing them all from the first Turn whose *Run* failed
  // would hide the case `state_status` exists for: a Turn that answers, reports success, and
  // leaves its State parked. That combination is reachable, so it must not fall through to the
  // last Turn's value.
  // `??` would be wrong here: a `turnStatus` of null is itself the "never completed" signal, and
  // coalescing it away would report the last Turn's success instead.
  const firstBad = <K extends "runStatus" | "stateStatus" | "turnStatus">(
    key: K
  ): PersistedTurn[K] => {
    const bad = turns.find((turn) => turn[key] !== "succeeded");
    return bad === undefined ? last[key] : bad[key];
  };
  return {
    ...last,
    runStatus: firstBad("runStatus"),
    stateStatus: firstBad("stateStatus"),
    turnStatus: firstBad("turnStatus"),
    events: turns.flatMap((turn) => turn.events),
    toolCalls: turns.flatMap((turn) => turn.toolCalls),
    soulCommits: turns.flatMap((turn) => turn.soulCommits),
    generatedFiles: turns.flatMap((turn) => turn.generatedFiles),
    toolDenials: turns.flatMap((turn) => turn.toolDenials),
    spend: turns.reduce<Spend>((total, turn) => mergeSpend(total, turn.spend), NO_SPEND),
  };
}

/**
 * Runs a Case's Turn, then each Turn of its journey, against one Conversation and one database.
 */
export async function runPersistedTurn(options: L3Options): Promise<PersistedTurn> {
  const database = options.database ?? (await openEvalDatabase());
  const owned = options.database === undefined;
  const conversationId = randomUUID();
  let soulWrites: SoulWriterTool | undefined;

  try {
    // Inside the `try`: it shells out to git, and constructing it above would leak the database
    // opened on the line before if that throws.
    soulWrites = soulWriterTool(options.soul);
    // Seeded before the first Turn, because the audience is resolved during the Turn and a Role
    // assigned afterwards would be a Role the File was never offered to.
    await seedAgentRoles({
      database,
      businessId: BUSINESS_ID,
      agentId: options.evalCase.agent,
      roleIds: options.evalCase.agentRoles ?? [],
    });
    // One store for the whole journey, so a later Turn cannot silently start a second library.
    const activeRun = { id: "" };
    const files = evalFileStore({
      database,
      businessId: BUSINESS_ID,
      principalId: PARTICIPANT_ID,
      agentId: options.evalCase.agent,
      runId: () => activeRun.id,
    });
    const first = await runOneTurn(options, {
      database,
      conversationId,
      soul: options.soul,
      soulWrites,
      files,
      activeRun,
      submit: options.evalCase.input,
    });
    const journey = options.evalCase.journey ?? [];
    if (journey.length === 0) return first;

    const turns: PersistedTurn[] = [first];
    for (const turn of journey) {
      // Reloaded per Turn so an artifact the previous Turn committed is visible to this one, and
      // history is re-read so this Turn is handed what was actually persisted.
      const soul = await options.soul.reload();
      const history = await priorMessages(database, conversationId);
      turns.push(
        await runOneTurn(
          { ...options, evalCase: journeyCase(options.evalCase, turn, history) },
          { database, conversationId, soul, soulWrites, files, activeRun, submit: turn.input }
        )
      );
    }
    return foldJourney(turns);
  } finally {
    // Before the database, because a Soul left dirty contaminates the next Trial in a way a fresh
    // database cannot undo: the Soul is loaded once per Sweep and shared.
    // The reset shells out to git and can throw; the database must be closed regardless, or a
    // Sweep leaks one PGlite instance per Trial for the rest of the run.
    try {
      soulWrites?.reset();
    } finally {
      if (owned) await database.close();
    }
  }
}

/** A journey Turn, expressed as the single-Turn Case the rest of the tier already knows how to run. */
function journeyCase(
  evalCase: EvalCase,
  turn: JourneyTurn,
  history: readonly ModelMessage[]
): EvalCase {
  return {
    ...evalCase,
    input: [...history, ...turn.input],
    toolResults: turn.toolResults,
    script: turn.script,
    journey: undefined,
  };
}
