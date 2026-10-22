// Copy for a reply whose model call failed. The turn's error code is `model-<reason>`; provider messages never reach the page.

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
  'model-rate-limit': 'The model provider is busy. Wait a moment, then retry the reply.',
  'model-quota':
    'The model provider has no available quota. Select another model and send a new message, or contact your workspace administrator.',
  'model-overload': `The model provider is overloaded. Retry the reply shortly. ${switchModel}`,
  'model-unavailable': `The model provider is unavailable right now. Retry the reply shortly. ${switchModel}`,
  'model-timeout': `The model took too long to respond. Retry the reply. ${switchModel}`,
  'model-transport': 'TulipFarm could not reach the model provider. Retry the reply shortly.',
  'model-refusal': 'The model declined this request. Revise the request or cancel the reply.',
  'model-invalid-request': `The model provider rejected this request. ${switchModel}`,
  'model-context-overflow':
    'This conversation exceeds the model context limit. Start a new chat with a shorter request.',
  'model-cancelled': 'The model call was cancelled before the reply finished. Retry the reply.',
};

const genericFailure = `The model provider could not complete the reply. Retry uses the original model. ${switchModel} Check any tool activity before requesting another action.`;

/** In-chat text for a failed reply, or null when the failure is not a model failure. */
export function replyFailure(code: string | null | undefined): string | null {
  if (!code?.startsWith('model-') || code.startsWith(modelFallbackPrefix)) return null;
  return replyFailures[code] ?? genericFailure;
}

/** Shown while a reply whose model call failed waits for its automatic retry, so it is never a silent spinner. */
export function replyRetrying(status: string, code: string | null | undefined): string | null {
  if (status !== 'queued' || !code) return null;
  if (code.startsWith('model-') && !code.startsWith(modelFallbackPrefix))
    return 'The model call failed. Retrying automatically…';
  if (code === 'transient-failure') return 'The reply hit a temporary problem. Retrying automatically…';
  return null;
}

/** A completed reply answered by the configured fallback model names that model. */
export function fallbackNote(status: string, code: string | null | undefined): string | null {
  if (status !== 'completed' || !code?.startsWith(modelFallbackPrefix)) return null;
  const family = code.slice(modelFallbackPrefix.length);
  return family ? `Answered by ${family} because the chat model was unavailable.` : null;
}
