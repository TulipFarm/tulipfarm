import { classifyStatus, gradeCase, type JudgeModel } from './checks.ts';
import {
  addUsage,
  emptyUsage,
  type CaseResult,
  type CompletionStatus,
  type EvalCase,
  type Transcript,
  type Usage,
} from './contracts.ts';
import { EvalCapReached, type Caps } from './caps.ts';
import { message } from './effects.ts';

/** Counts the model requests and usage of one reply, and enforces the run's caps. */
export interface EvalMeter {
  /** Call before each model request. Throws `EvalCapReached` when the run is out of requests or money. */
  request(): void;
  /** Call with each finished request's usage. */
  usage(usage: Omit<Usage, 'requests'>): void;
}

/** A reply as the driver saw it. `status` is null when the reply's structure does not decide it. */
export type DriverTranscript = Omit<Transcript, 'status'> & { status: CompletionStatus | null };

/** Sends one case to the agent under test and returns what its reply did. */
export type EvalDriver = (input: {
  evalCase: EvalCase;
  model: string;
  repeat: number;
  meter: EvalMeter;
  signal?: AbortSignal | undefined;
}) => Promise<DriverTranscript>;

export interface RunEvalsInput {
  cases: readonly EvalCase[];
  models: readonly string[];
  repeats: number;
  driver: EvalDriver;
  caps: Caps;
  /** The AI judge's model. Without one, judge checks fail with a reason. */
  judge?: JudgeModel;
  signal?: AbortSignal;
  /** Called after each case × repeat × model, for progress and storage. */
  onResult?(result: CaseResult): Promise<void> | void;
}

export type RunStop = { reason: 'cap'; cap: EvalCapReached['cap']; message: string } | { reason: 'cancelled' };

// The chat runtime may catch a cap error and end the turn without a reply, so the meter also records it for the runner.
function meterInto(caps: Caps, usage: Usage, reached: { cap: EvalCapReached | null }): EvalMeter {
  return {
    request() {
      try {
        caps.request();
      } catch (error) {
        if (error instanceof EvalCapReached) reached.cap ??= error;
        throw error;
      }
      usage.requests++;
    },
    usage(more) {
      usage.inputTokens += more.inputTokens;
      usage.outputTokens += more.outputTokens;
      usage.picoUsd += more.picoUsd;
      caps.spend(more.picoUsd);
    },
  };
}

/** Runs every case × repeat × model in order and grades each reply. A cap stops the whole run. */
export async function runEvals(input: RunEvalsInput) {
  const results: CaseResult[] = [];
  const agentUsage = emptyUsage();
  const judgeUsage = emptyUsage();
  let stopped: RunStop | null = null;
  outer: for (const model of input.models)
    for (let repeat = 0; repeat < input.repeats; repeat++)
      for (const evalCase of input.cases) {
        if (input.signal?.aborted) {
          stopped = { reason: 'cancelled' };
          break outer;
        }
        const started = Date.now();
        const result: CaseResult = {
          caseId: evalCase.id,
          model,
          repeat,
          pass: false,
          verdicts: [],
          transcript: null,
          error: null,
          agentUsage: emptyUsage(),
          judgeUsage: emptyUsage(),
          durationMs: 0,
        };
        const reached: { cap: EvalCapReached | null } = { cap: null };
        try {
          input.caps.reply();
          const reply = await input.driver({
            evalCase,
            model,
            repeat,
            meter: meterInto(input.caps, result.agentUsage, reached),
            signal: input.signal,
          });
          if (reached.cap) throw reached.cap;
          const judge = input.judge;
          const metered: JudgeModel | undefined =
            judge &&
            (async request => {
              const meter = meterInto(input.caps, result.judgeUsage, reached);
              meter.request();
              const answer = await judge(request);
              meter.usage(answer.usage);
              return { ...answer, usage: emptyUsage() };
            });
          const status =
            reply.status ??
            (metered && evalCase.checks.some(check => check.kind === 'status')
              ? await classifyStatus(evalCase, reply, metered)
              : null) ??
            'completed';
          result.transcript = { ...reply, status };
          const graded = await gradeCase(evalCase, result.transcript, metered);
          result.verdicts = graded.verdicts;
          result.pass = graded.pass;
        } catch (error) {
          const cap = error instanceof EvalCapReached ? error : reached.cap;
          result.error = message(cap ?? error);
          if (cap) stopped = { reason: 'cap', cap: cap.cap, message: cap.message };
        }
        result.durationMs = Date.now() - started;
        addUsage(agentUsage, result.agentUsage);
        addUsage(judgeUsage, result.judgeUsage);
        results.push(result);
        await input.onResult?.(result);
        if (stopped) break outer;
      }
  return { results, stopped, agentUsage, judgeUsage };
}
export type EvalRunOutcome = Awaited<ReturnType<typeof runEvals>>;
