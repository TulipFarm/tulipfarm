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
  copilot: 'https://github.com/settings/copilot/features',
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

/** A completed reply answered by the configured fallback model names that model and the chat model it replaced. */
export function fallbackNote(
  status: string,
  code: string | null | undefined,
  chatModel?: string,
  name: (id: string) => string = id => id,
): string | null {
  if (status !== 'completed' || !code?.startsWith(modelFallbackPrefix)) return null;
  const family = code.slice(modelFallbackPrefix.length);
  if (!family) return null;
  // Plan families are named after their provider in the catalog, such as `chatgpt-sol` or `claude-plan-opus`.
  const prefix = /^(chatgpt|claude-plan|copilot)-/.exec(chatModel ?? '')?.[1];
  const plan = prefix === 'claude-plan' ? 'claude' : (prefix as keyof typeof planLabels | undefined);
  if (plan)
    return `Answered by ${name(family)} because every ${planLabels[plan]} plan you can use had reached its limit or needed sign-in again.`;
  const replaced = chatModel && chatModel !== family ? name(chatModel) : 'the chat model';
  return `Answered by ${name(family)} because ${replaced} was unavailable.`;
}

/** The model family that wrote a reply: the configured fallback when it answered, else the chat model. */
export function replyModel(model: string | undefined, code: string | null | undefined): string | undefined {
  return code?.startsWith(modelFallbackPrefix) ? code.slice(modelFallbackPrefix.length) || model : model;
}
