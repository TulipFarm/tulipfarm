// Drives the real chat path for internal eval suites: a disposable workspace, the conversation executor and
// `inferWithTools`, with every tool call routed through the eval effects layer.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { calculateModelCost } from '@tulipfarm/config';
import { createConversationExecutor } from '@tulipfarm/conversations/runtime';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { completionStatusObserver, inferWithTools, isPlanRoute } from '../../agents/src/inference.ts';
import { modelEnvironment } from '../../agents/src/model-environment.ts';
import { createChatTools, isExternalTool, readOnlyCall } from '../../agents/src/tools.ts';
import { createEffects } from '../src/effects.ts';

// Chat tools whose call asks the person to review or approve a change rather than making it.
const approvalTools = new Set([
  'rows.create',
  'rows.create.batch',
  'rows.update',
  'rows.update.batch',
  'rows.delete',
  'tables.propose',
]);

let copilotToken;
function planToken() {
  copilotToken ??=
    process.env.EVALS_COPILOT_TOKEN?.trim() ||
    execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return copilotToken;
}

/** The inference route for a catalog model. Copilot and other plan models use EVALS_COPILOT_TOKEN or `gh auth token`. */
export function routeFor(model) {
  const route = modelEnvironment().route(model);
  if (!route) throw new Error(`Model ${model} is not in the catalog or its server credentials are not set`);
  return isPlanRoute(route) ? { ...route, accessToken: planToken() } : route;
}

/** Provider cost of one request in picodollars; 0 when the model has no price, such as a plan model. */
export function priceFor(model, usage) {
  if (usage.kind !== 'known') return 0;
  const env = modelEnvironment();
  try {
    const resolution = env.resolve(model);
    if (!resolution) return 0;
    const { kind, ...tokens } = usage;
    const cost = calculateModelCost({
      resolution,
      usage: { kind, tokens },
      date: new Date().toISOString().slice(0, 10),
      trustedBundle: env.bundle,
    });
    return cost.kind === 'known' ? Number(cost.providerPicoUsd) : 0;
  } catch {
    return 0;
  }
}

function meterFor(model, meter) {
  return async () => {
    meter.request();
    return async usage => {
      meter.usage({
        inputTokens: usage.kind === 'known' ? usage.input + usage.cacheRead + usage.cacheWrite : 0,
        outputTokens: usage.kind === 'known' ? usage.output : 0,
        picoUsd: priceFor(model, usage),
      });
    };
  };
}

/** A judge on `model` through the same chat path, with no tools. */
export function chatJudge(model) {
  return async ({ system, user }) => {
    const spent = { requests: 0, inputTokens: 0, outputTokens: 0, picoUsd: 0 };
    const meter = {
      request: () => void spent.requests++,
      usage: usage => {
        spent.inputTokens += usage.inputTokens ?? 0;
        spent.outputTokens += usage.outputTokens ?? 0;
        spent.picoUsd += usage.picoUsd ?? 0;
      },
    };
    const answer = await inferWithTools(
      routeFor(model),
      [{ role: 'user', text: `${system}\n\n${user}` }],
      async () => ({ error: 'tool-unavailable', instruction: 'The judge has no tools. Answer with the JSON verdict.' }),
      meterFor(model, meter),
    );
    return { text: answer.text, usage: spent };
  };
}

/**
 * Opens a disposable workspace and returns a driver for `runEvals`.
 *
 * - `setup(fixture)` prepares the workspace, such as teams.
 * - `allowedTools`, when set, refuses every other tool the way the original table eval did.
 * - `liveWrites` lists write tools that may run for real in this disposable workspace.
 */
export async function chatHarness({ setup, allowedTools, liveWrites } = {}) {
  const f = await conversationFixture();
  try {
    await setup?.(f);
  } catch (error) {
    await f.close();
    throw error;
  }
  const w = f.workspace;
  const driver = async ({ evalCase, model, meter }) => {
    let live;
    const effects = createEffects({
      isRead: readOnlyCall,
      isApproval: call => approvalTools.has(call.tool),
      live: call => live(call),
      pinnedReads: evalCase.pinnedReads,
      effectOverrides: evalCase.effectOverrides,
      ...(liveWrites ? { liveWrites } : {}),
    });
    let text = null;
    const executor = createConversationExecutor(f.runtime, async ({ messages, executeTool }) => {
      live = async call =>
        (
          await executeTool(
            call.tool,
            isExternalTool(call.tool),
            context => createChatTools(context.runtime).invokeWithSources(context, call),
            [],
            call,
            call.tool,
          )
        ).result;
      const answer = await inferWithTools(
        routeFor(model),
        [...evalCase.priorTurns, ...messages],
        async call => {
          if (allowedTools && !allowedTools.has(call.tool))
            return { error: 'tool-unavailable', instruction: 'This evaluation does not offer that tool.' };
          return effects.call(call);
        },
        meterFor(model, meter),
      );
      text = answer.text;
      return answer.text;
    });
    let status = null;
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    const sent = await f.store.send(w.id, w.userId, chatId, {
      commandId: randomUUID(),
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: evalCase.message }],
    });
    const outcome = await completionStatusObserver.run(
      checked => {
        status = checked === 'continue' ? null : checked;
      },
      () => executor.process({ workspaceId: w.id, conversationId: chatId, turnId: sent.turnId, generation: 0 }),
    );
    if (text === null) throw new Error(`The chat turn ended without a reply (${outcome})`);
    return { text, status, calls: effects.calls };
  };
  return { driver, fixture: f, close: () => f.close() };
}
