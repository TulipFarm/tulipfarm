import { modelFallbackReasons, type ModelFallbackReason } from '@tulipfarm/config/model-fallback';
import type { ConversationMessage } from './conversation-api.ts';

// Copy for a failed reply. Model failures use `model-<reason>`; provider messages and internal codes never reach the page.

// Mirrors `modelFallbackCodePrefix` in @tulipfarm/conversations/contracts.
const modelFallbackPrefix = 'model-fallback:';

const switchModel = 'To use another model, select it and send a new message.';

const replyFailures: Record<string, string> = {
  'model-incomplete-response':
    'The agent stopped without finishing your request. Completed tool results are kept. Review them, then retry the reply to continue.',
  'model-invalid-decision': `The model could not produce a valid answer or tool request. Retry uses the original model. ${switchModel}`,
  'model-invalid-response': `The model sent a reply TulipFarm could not read. Retry uses the original model. ${switchModel}`,
  'model-output-limit':
    'The model reached its response limit. Send a new message with a smaller request or select another model before sending.',
  'model-configuration': "This model isn't available. Select another model and send your message again.",
  'model-authentication': `This model is unavailable right now because its provider rejected TulipFarm's credentials. ${switchModel} A workspace admin can check the model setup.`,
  'model-permission': `This model is unavailable right now because its provider denied access. ${switchModel} A workspace admin can check the model setup.`,
  'model-rate-limit':
    'The model provider is limiting requests, so no answer was written. TulipFarm retried automatically. Wait a minute, then retry the reply.',
  'model-quota':
    'The model provider has no available quota. Select another model and send a new message, or contact your workspace administrator.',
  'model-overload': `The model provider is overloaded, so no answer was written. TulipFarm retried automatically. Retry the reply later. ${switchModel}`,
  'model-unavailable': `The model provider is unavailable, so no answer was written. TulipFarm retried automatically. Retry the reply later. ${switchModel}`,
  'model-timeout': `The model took too long to respond, so no answer was written. TulipFarm retried automatically. Retry the reply. ${switchModel}`,
  'model-transport':
    'TulipFarm could not reach the model provider, so no answer was written. It retried automatically. Retry the reply later.',
  'model-refusal':
    "The model declined this request, or its provider's safety filter blocked it. Reword your message and send it again.",
  'model-invalid-request': `The model provider rejected this request. ${switchModel}`,
  'model-context-overflow':
    'This conversation exceeds the model context limit. Start a new chat with a shorter request.',
  'model-cancelled': 'The model call was cancelled before the reply finished. Retry the reply.',
  'model-chatgpt-usage-limit':
    "Usage limit reached. Review your ChatGPT plan or TulipFarm's limit in ChatGPT settings.",
  'model-chatgpt-reconnect': `ChatGPT needs you to sign in again before TulipFarm can use your plan. ${switchModel}`,
  'model-chatgpt-not-eligible': `Your ChatGPT account can't be used for requests from TulipFarm, because of its plan, workspace or a ChatGPT policy. ${switchModel}`,
  'model-chatgpt-member-required': `ChatGPT plan models run only in your own chats, after you connect ChatGPT in Models settings. ${switchModel}`,
  'model-claude-usage-limit': "Usage limit reached. Review your Claude plan's usage in Claude settings.",
  'model-claude-reconnect': `Claude needs you to connect again before TulipFarm can use your plan. ${switchModel}`,
  'model-claude-not-eligible': `Your Claude account can't be used for requests from TulipFarm, because of its plan or a Claude policy. ${switchModel}`,
  'model-claude-member-required': `Claude plan models run only in your own chats, after you connect Claude in Models settings. ${switchModel}`,
  'model-copilot-usage-limit': 'Usage limit reached. Review your GitHub Copilot premium requests in GitHub settings.',
  'model-copilot-reconnect': `GitHub Copilot needs you to sign in again before TulipFarm can use your plan. ${switchModel}`,
  'model-copilot-not-eligible': `Your GitHub Copilot plan can't run this model, or a Copilot policy blocks it. ${switchModel}`,
  'model-copilot-member-required': `Copilot plan models run only in your own chats, after you connect GitHub Copilot in Models settings. ${switchModel}`,
};

/** The ChatGPT usage page, where a member reviews their plan and TulipFarm's limit. */
export const chatGptUsageUrl = 'https://chatgpt.com/settings/usage';

/** Where a member reviews each plan's usage. */
export const planUsageUrls = {
  chatgpt: chatGptUsageUrl,
  claude: 'https://claude.ai/settings/usage',
  copilot: 'https://github.com/settings/copilot',
} as const;
export const planLabels = { chatgpt: 'ChatGPT', claude: 'Claude', copilot: 'GitHub Copilot' } as const;

/** The recovery action a failed plan reply offers, if any. */
export function planFailureAction(
  code: string | null | undefined,
): { kind: 'manage-usage'; label: string; href: string } | { kind: 'reconnect'; label: string } | null {
  const match = /^model-(chatgpt|claude|copilot)-(usage-limit|reconnect)$/.exec(code ?? '');
  if (!match) return null;
  const provider = match[1] as keyof typeof planLabels;
  if (match[2] === 'usage-limit') return { kind: 'manage-usage', label: 'Manage usage', href: planUsageUrls[provider] };
  return { kind: 'reconnect', label: `Reconnect ${planLabels[provider]}` };
}

const genericFailure = `The model provider could not complete the reply. Retry uses the original model. ${switchModel} Check any tool activity before requesting another action.`;

const kept = 'Your completed work is kept.';
export const unknownStop = `Something went wrong while working on this. ${kept}`;
const stopReasons: Record<string, string> = {
  'transient-failure': unknownStop,
  'reply-interrupted': `The reply stopped before it finished. ${kept}`,
  'database-conflict': `The reply stopped because another change was saving at the same time. ${kept}`,
  'attempts-exhausted': `The reply kept hitting a temporary problem, so no answer was written. TulipFarm retried automatically. ${kept} Continue or retry the reply.`,
  'github-rate-limited': `GitHub is limiting requests. Wait a minute, then retry. ${kept}`,
  'access-denied': `The reply stopped because access to something it needed was denied. ${kept}`,
  'tool-unavailable': `The reply stopped because it asked for a tool that isn't available. ${kept}`,
  'project-context-too-large':
    'The project context is too large for this reply. Shorten the project context, then retry.',
};
// These codes have their own message in the chat.
const explainedElsewhere = new Set(['credits-exhausted', 'plan-budget', 'skill-unavailable']);

/** In-chat text for why a failed reply stopped, or null when the chat explains the code with its own message. */
export function replyFailure(code: string | null | undefined): string | null {
  if (code?.startsWith(modelFallbackPrefix)) return null;
  if (code?.startsWith('model-')) return replyFailures[code] ?? genericFailure;
  if (code && explainedElsewhere.has(code)) return null;
  return (code && stopReasons[code]) || unknownStop;
}

/**
 * A failed reply that already saved a table change proposal lost only its text: the proposal card is valid and can
 * be approved, so the reply doesn't read as failed.
 */
export function proposalKeptNote(tools: readonly { tableProposal?: true | undefined }[]): string | null {
  return tools.some(tool => tool.tableProposal)
    ? 'Reply text missing. The table change proposal from this reply is still valid.'
    : null;
}

// Retrying sends the same request to the same model, so these failures would only repeat.
const repeatsOnRetry = new Set(['model-refusal', 'model-invalid-request']);

/** Whether retrying a failed reply can succeed, so a request certain to fail again offers no retry. */
export function retryHelps(code: string | null | undefined): boolean {
  return !code || !repeatsOnRetry.has(code);
}

/** A failed reply with completed tool calls continues from them; otherwise it is retried from the start. */
export function retryLabel(code: string | null | undefined, resumes: boolean, compacts: boolean): string {
  if (compacts) return 'Compact and retry';
  return resumes ? 'Continue' : 'Retry reply';
}

/** Shown while a reply whose model call failed waits for its automatic retry, so it is never a silent spinner. */
export function replyRetrying(status: string, code: string | null | undefined): string | null {
  if (status !== 'queued' || !code) return null;
  if (code.startsWith('model-') && !code.startsWith(modelFallbackPrefix))
    return 'The model provider returned an error. Retrying automatically…';
  if (code === 'transient-failure' || code === 'database-conflict')
    return 'The reply hit a temporary problem. Retrying automatically…';
  return null;
}

/**
 * A completed turn's fallback code: the family that answered, why the chat model failed when that is known, and
 * whether the failed plan was the requester's own.
 */
function fallbackCode(
  code: string | null | undefined,
): { family: string; reason?: ModelFallbackReason; own: boolean } | null {
  if (!code?.startsWith(modelFallbackPrefix)) return null;
  const [family = '', reason, owner] = code.slice(modelFallbackPrefix.length).split(':');
  if (!family) return null;
  return (modelFallbackReasons as readonly string[]).includes(reason ?? '')
    ? { family, reason: reason as ModelFallbackReason, own: owner === 'own' }
    : { family, own: false };
}

// Why a plan model couldn't answer; `plan` is the plan's name, `model` the chat model's, and `own` whether the plan is
// the requester's rather than one a teammate or the workspace shares.
const planFallbackCauses: Record<
  ModelFallbackReason,
  (plan: keyof typeof planLabels, model: string, own: boolean) => string
> = {
  quota: (plan, _model, own) =>
    plan === 'copilot'
      ? own
        ? 'Your GitHub Copilot premium quota is used up'
        : "The GitHub Copilot plan's premium quota is used up"
      : `${own ? 'Your' : 'The'} ${planLabels[plan]} plan's usage limit is reached`,
  'rate-limit': plan => `${planLabels[plan]} is limiting requests right now`,
  outage: plan => `${planLabels[plan]} isn't responding right now`,
  timeout: plan => `${planLabels[plan]} took too long to respond`,
  'model-unavailable': (plan, model, own) =>
    `${model} isn't available on ${own ? 'your' : 'the'} ${planLabels[plan]} plan`,
  'sign-in': plan => `${planLabels[plan]} needs to be reconnected`,
};
// Why another chat model couldn't answer; `model` is its name.
const modelFallbackCauses: Record<ModelFallbackReason, (model: string) => string> = {
  quota: model => `${model} has no quota left with its provider`,
  'rate-limit': model => `${model}'s provider is limiting requests right now`,
  outage: model => `${model} isn't responding right now`,
  timeout: model => `${model} took too long to respond`,
  'model-unavailable': model => `${model} isn't available right now`,
  'sign-in': model => `${model}'s provider rejected TulipFarm's credentials`,
};

/**
 * A completed reply answered by the configured fallback model names that model and, when the turn knows it, why the
 * chat model it replaced couldn't answer.
 */
export function fallbackNote(
  status: string,
  code: string | null | undefined,
  chatModel?: string,
  name: (id: string) => string = id => id,
): string | null {
  const fallback = status === 'completed' ? fallbackCode(code) : null;
  if (!fallback) return null;
  const { family, reason, own } = fallback;
  // Plan families are named after their provider in the catalog, such as `chatgpt-sol` or `claude-plan-opus`.
  const prefix = /^(chatgpt|claude-plan|copilot)-/.exec(chatModel ?? '')?.[1];
  const plan = prefix === 'claude-plan' ? 'claude' : (prefix as keyof typeof planLabels | undefined);
  const replaced = chatModel && chatModel !== family ? name(chatModel) : undefined;
  if (plan && reason)
    return `${planFallbackCauses[reason](plan, replaced ?? 'This model', own)}, so ${name(family)} answered.`;
  if (plan) return `No ${planLabels[plan]} plan you can use could answer, so ${name(family)} did.`;
  if (reason) return `${modelFallbackCauses[reason](replaced ?? 'The chat model')}, so ${name(family)} answered.`;
  return `Answered by ${name(family)} because ${replaced ?? 'the chat model'} was unavailable.`;
}

export type FallbackTone = 'warning' | 'info' | 'action';
export type FallbackSummary = {
  /** The family that answered, and the chat model the member had chosen. */
  family: string;
  chosen: string | undefined;
  answered: string;
  replaced: string;
  plan: keyof typeof planLabels | undefined;
  reason: ModelFallbackReason | undefined;
  own: boolean;
  tone: FallbackTone;
  /** A few words on why, for the chip. */
  short: string;
  /** The full sentence, for its details. */
  detail: string;
};

/** Why the fallback model answered a completed reply, in short and in full, or null when the chat model answered. */
export function fallbackSummary(
  status: string,
  code: string | null | undefined,
  chatModel?: string,
  name: (id: string) => string = id => id,
): FallbackSummary | null {
  const fallback = status === 'completed' ? fallbackCode(code) : null;
  const detail = fallbackNote(status, code, chatModel, name);
  if (!fallback || !detail) return null;
  const { family, reason, own } = fallback;
  const prefix = /^(chatgpt|claude-plan|copilot)-/.exec(chatModel ?? '')?.[1];
  const plan = prefix === 'claude-plan' ? 'claude' : (prefix as keyof typeof planLabels | undefined);
  const chosen = chatModel && chatModel !== family ? chatModel : undefined;
  const replaced = chosen ? name(chosen) : 'The chat model';
  const source = plan ? planLabels[plan] : replaced;
  const whose = own ? 'Your' : 'The';
  const shortByReason: Record<ModelFallbackReason, string> = {
    quota: plan ? `${whose} ${source} plan limit is reached` : `${source} has no quota left`,
    'rate-limit': `${source} is limiting requests`,
    outage: `${source} isn't responding`,
    timeout: `${source} took too long`,
    'model-unavailable': plan
      ? `${replaced} isn't on ${own ? 'your' : 'the'} ${source} plan`
      : `${replaced} isn't available`,
    'sign-in': plan
      ? own
        ? `${source} needs reconnecting`
        : `The ${source} plan needs reconnecting`
      : `${source} sign-in failed`,
  };
  // Only a plan's owner can reconnect it, so a shared plan's sign-in is a heads-up rather than an action.
  const tone: FallbackTone =
    reason === 'sign-in' && own && plan
      ? 'action'
      : reason === 'quota' || reason === 'model-unavailable' || reason === 'sign-in'
        ? 'warning'
        : 'info';
  return {
    family,
    chosen,
    answered: name(family),
    replaced,
    plan,
    reason,
    own,
    tone,
    short: reason ? shortByReason[reason] : `${replaced} was unavailable`,
    detail,
  };
}

/** The model family that wrote a reply: the configured fallback when it answered, else the chat model. */
export function replyModel(model: string | undefined, code: string | null | undefined): string | undefined {
  return fallbackCode(code)?.family ?? model;
}

type Turn = NonNullable<ConversationMessage['turn']>;

/**
 * For each reply the fallback model wrote, the turn it answered, when that reply starts a fallback: a run of replies
 * answered by the same fallback for the same chosen model shows its chip once, above the first of them.
 */
export function fallbackStarts(messages: readonly ConversationMessage[]): Map<string, Turn> {
  const starts = new Map<string, Turn>();
  let pending: Turn | null = null;
  let previous: string | null = null;
  for (const message of messages) {
    if (message.turn) {
      pending = message.turn;
      continue;
    }
    if (message.author !== 'assistant' || !pending) continue;
    const turn = pending;
    pending = null;
    const code = turn.status === 'completed' && turn.errorCode?.startsWith('model-fallback:') ? turn.errorCode : null;
    const run = code ? `${turn.stats?.model ?? ''}>${code.split(':')[1]}` : null;
    if (run && run !== previous) starts.set(message.id, turn);
    if (turn.status === 'completed') previous = run;
  }
  return starts;
}
