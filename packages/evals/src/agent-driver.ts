import type { agentDefinitionSchema, scopeSchema } from '@tulipfarm/agents/contracts';
import type { InferenceResult } from '@tulipfarm/agents/inference';
import type { AgentModel } from '@tulipfarm/agents/model';
import { parseModelDecision } from '@tulipfarm/agents/model';
import type { z } from 'zod';
import type { CompletionStatus, EvalCase } from './contracts.ts';
import { createEffects, message, type EvalToolCall } from './effects.ts';
import type { DriverTranscript, EvalDriver } from './runner.ts';

type ModelInput = Parameters<AgentModel>[0];
type Decision = Awaited<ReturnType<AgentModel>>;

export interface AgentDriverOptions {
  definition: z.infer<typeof agentDefinitionSchema>;
  scope: z.infer<typeof scopeSchema>;
  /** The agent's skills, resolved for the person who started the run. */
  procedures?: ModelInput['procedures'];
  /** The task instructions the saved agent runs under. */
  instructions: string;
  /** One agent decision on `model`. Usage is reported through `meter`. */
  decide(model: string, input: ModelInput, signal?: AbortSignal): Promise<InferenceResult>;
  /** Provider cost of one decision's usage in picodollars, or 0 when unknown. */
  price(model: string, usage: InferenceResult['usage']): number;
  /** Whether a call changes nothing. */
  isRead(call: EvalToolCall): boolean;
  /** Runs a read-only call live with the starter's access. Throws when the agent may not make it. */
  live(call: EvalToolCall): Promise<unknown>;
  /** Decisions per reply before the run stops it as blocked. */
  maxSteps?: number;
}

const historyOf = (evalCase: EvalCase) =>
  [...evalCase.priorTurns, { role: 'user' as const, text: evalCase.message }].map((turn, sequence) => ({
    sequence,
    generation: 0,
    role: turn.role === 'user' ? ('owner' as const) : ('agent' as const),
    text: turn.text,
    sources: [],
    createdAt: new Date(0).toISOString(),
  }));

const callsOf = (decision: Decision): EvalToolCall[] =>
  decision.kind === 'tool'
    ? [decision.call as EvalToolCall]
    : decision.kind === 'tools'
      ? decision.calls.map(item => item.call as EvalToolCall)
      : [];

/**
 * Runs a saved agent the way a private agent task does, without a task: the agent decides, its read-only calls run
 * live or pinned, its approval requests are recorded and treated as approved, and every write is simulated.
 */
export function createAgentDriver(options: AgentDriverOptions): EvalDriver {
  const maxSteps = options.maxSteps ?? 12;
  return async ({ evalCase, model, meter, signal }): Promise<DriverTranscript> => {
    const effects = createEffects({
      isRead: options.isRead,
      live: options.live,
      pinnedReads: evalCase.pinnedReads,
      effectOverrides: evalCase.effectOverrides,
    });
    const history = historyOf(evalCase);
    const results: { call: EvalToolCall; status: string; result: unknown }[] = [];
    const rejected: string[] = [];
    const finish = (text: string, status: CompletionStatus | null): DriverTranscript => ({
      text,
      status,
      calls: effects.calls,
    });
    for (let step = 0; step < maxSteps; step++) {
      signal?.throwIfAborted();
      const input: ModelInput = {
        prompt: JSON.stringify({
          instructions: options.instructions,
          ...(rejected.length
            ? {
                rejectedSteps: {
                  notice:
                    'Your latest steps could not be used, so the task did not take them. Choose a step that avoids them.',
                  reasons: rejected.slice(-3),
                },
              }
            : {}),
          history,
          results,
          references: [],
          files: [],
          destinations: [],
        }).slice(0, 32000),
        definition: options.definition,
        scope: options.scope,
        ...(options.procedures ? { procedures: options.procedures } : {}),
        task: true,
      };
      meter.request();
      const result = await options.decide(model, input, signal);
      const picoUsd = options.price(model, result.usage);
      meter.usage({
        inputTokens: result.usage.kind === 'known' ? result.usage.input + result.usage.cacheRead : 0,
        outputTokens: result.usage.kind === 'known' ? result.usage.output : 0,
        picoUsd,
      });
      if (result.kind === 'failure') {
        if (result.reason === 'refusal') return finish('', 'refused');
        throw new Error(`The agent's model failed: ${result.reason}`);
      }
      let decision: Decision;
      try {
        decision = parseModelDecision(result.decision, input);
      } catch (error) {
        rejected.push(message(error));
        continue;
      }
      if (decision.kind === 'answer') return finish(decision.text, decision.incomplete ? 'blocked' : null);
      if (decision.kind === 'clarify') return finish(decision.text, 'waiting');
      if (decision.kind === 'propose') {
        const proposed = decision.calls as EvalToolCall[];
        effects
          .approve(proposed)
          .forEach((result, i) => results.push({ call: proposed[i]!, status: 'completed', result }));
        continue;
      }
      for (const call of callsOf(decision)) {
        try {
          results.push({ call, status: 'completed', result: await effects.call(call) });
        } catch (error) {
          results.push({ call, status: 'failed', result: { error: message(error) } });
        }
      }
    }
    return finish('The agent did not finish within the eval step limit.', 'blocked');
  };
}
