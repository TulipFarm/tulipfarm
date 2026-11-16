/**
 * Why a fallback model answered a reply instead of the chat model. A completed turn's error code carries it after the
 * fallback's family id, so the chat can say what happened in plain words.
 */
export const modelFallbackReasons = Object.freeze([
  'quota',
  'rate-limit',
  'outage',
  'timeout',
  'model-unavailable',
  'sign-in',
] as const);
export type ModelFallbackReason = (typeof modelFallbackReasons)[number];

/** The fallback reason for a failed model call's `model-<reason>` reason, such as `copilot-usage-limit`, if known. */
export function modelFallbackReason(failure: string | undefined): ModelFallbackReason | undefined {
  if (!failure) return undefined;
  if (failure === 'quota' || failure.endsWith('-usage-limit')) return 'quota';
  if (failure === 'rate-limit') return 'rate-limit';
  if (failure === 'timeout') return 'timeout';
  if (failure === 'unavailable' || failure === 'overload' || failure === 'transport') return 'outage';
  if (failure === 'authentication' || failure.endsWith('-reconnect')) return 'sign-in';
  if (
    failure === 'configuration' ||
    failure === 'permission' ||
    failure.endsWith('-not-eligible') ||
    failure.endsWith('-member-required')
  )
    return 'model-unavailable';
  return undefined;
}
