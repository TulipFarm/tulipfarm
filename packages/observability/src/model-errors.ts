/**
 * Bounded classification of a failed model call. It is the only model failure value that becomes `error.code`,
 * `error.type` or a metric label; provider codes and messages stay in logs.
 */
export const modelErrorClasses = Object.freeze([
  'auth',
  'not_found',
  'rate_limited',
  'quota_exceeded',
  'bad_request',
  'content_filtered',
  'context_too_long',
  'timeout',
  'network',
  'server_error',
  'invalid_response',
  'cancelled',
  'unknown',
] as const);
export type ModelErrorClass = (typeof modelErrorClasses)[number];

/** The `model-<reason>` failures inference throws, and the class each one reports as. */
export const modelFailureClasses = Object.freeze({
  configuration: 'not_found',
  authentication: 'auth',
  permission: 'auth',
  quota: 'quota_exceeded',
  'rate-limit': 'rate_limited',
  overload: 'server_error',
  unavailable: 'server_error',
  refusal: 'content_filtered',
  'context-overflow': 'context_too_long',
  'invalid-request': 'bad_request',
  'invalid-decision': 'invalid_response',
  'invalid-response': 'invalid_response',
  'incomplete-response': 'invalid_response',
  'output-limit': 'invalid_response',
  cancelled: 'cancelled',
  timeout: 'timeout',
  transport: 'network',
  'provider-error': 'unknown',
  'request-failed': 'unknown',
} as const satisfies Record<string, ModelErrorClass>);
export type ModelFailureReason = keyof typeof modelFailureClasses;

/** The class of a `model-<reason>` error message, or undefined for any other text. */
export function modelErrorClass(message: unknown): ModelErrorClass | undefined {
  if (typeof message !== 'string' || !message.startsWith('model-')) return undefined;
  const reason = message.slice('model-'.length);
  return Object.hasOwn(modelFailureClasses, reason) ? modelFailureClasses[reason as ModelFailureReason] : undefined;
}

/** Classes a different model can plausibly answer. Content, context and request-shape failures would fail there too. */
export const fallbackEligibleClasses: ReadonlySet<ModelErrorClass> = new Set([
  'not_found',
  'auth',
  'quota_exceeded',
  'rate_limited',
  'server_error',
  'timeout',
  'network',
]);

export const modelFallbackOutcomes = Object.freeze(['used', 'not_configured', 'not_eligible', 'failed'] as const);
export type ModelFallbackOutcome = (typeof modelFallbackOutcomes)[number];

/** Whether a successful model call reported token usage the runtime could read. */
export const modelUsageOutcomes = Object.freeze(['reported', 'unknown'] as const);
export type ModelUsageOutcome = (typeof modelUsageOutcomes)[number];
/** Why usage is unknown: the response had no usage object, or its usage did not parse or add up. */
export const modelUsageUnknownReasons = Object.freeze(['missing', 'invalid'] as const);
export type ModelUsageUnknownReason = (typeof modelUsageUnknownReasons)[number];
const usageShapePattern =
  /^[a-z0-9_.]{1,96}=(?:\d{1,16}|null|[a-z]{1,8})(?:,[a-z0-9_.]{1,96}=(?:\d{1,16}|null|[a-z]{1,8})){0,31}$/;

/**
 * The key names and counts of a provider usage object, for diagnosing usage the runtime cannot read.
 * Only lowercase field names and numbers are kept, so no text from the response can reach a log line.
 */
export function usageShape(usage: unknown): string | undefined {
  const fields: string[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (fields.length >= 32) return;
    if (value === null) fields.push(`${path}=null`);
    else if (typeof value === 'number')
      fields.push(`${path}=${Number.isSafeInteger(value) && value >= 0 ? value : 'nan'}`);
    else if (typeof value === 'object' && !Array.isArray(value) && depth < 2) {
      for (const [key, inner] of Object.entries(value))
        if (/^[a-z0-9_]{1,40}$/.test(key)) visit(inner, path ? `${path}.${key}` : key, depth + 1);
    } else fields.push(`${path}=${Array.isArray(value) ? 'array' : typeof value}`);
  };
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  visit(usage, '', 0);
  const shape = fields.join(',');
  return usageShapePattern.test(shape) ? shape : undefined;
}

/** A shape `usageShape` produced; anything else stays off log lines. */
export function safeUsageShape(value: unknown): boolean {
  return typeof value === 'string' && usageShapePattern.test(value);
}

const providerCodePattern = /^[A-Za-z0-9._:-]{1,64}$/;
export const providerMessageLimit = 200;

/** A provider error code safe to log: short, and only identifier characters. */
export function safeProviderCode(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && providerCodePattern.test(text) ? text : undefined;
}

/**
 * A provider error message reduced for logs: one line, no URLs, emails, keys, long tokens, quoted values or
 * identifiers, and at most {@link providerMessageLimit} characters. Provider messages can echo request content, so
 * quoted text is removed rather than kept.
 */
export function sanitizeProviderMessage(value: unknown, request?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .slice(0, 1000)
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b(?:bearer|basic)\s+\S+/gi, '[credential]')
    .replace(/\b(?:sk|pk|rk|ak|key|api[-_]?key|token|secret)[-_][A-Za-z0-9_-]{6,}\b/gi, '[credential]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/"[^"]{25,}"|'[^']{25,}'|`[^`]{25,}`|“[^”]{25,}”/g, '[text]')
    .replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, '[token]')
    .replace(/\s+/g, ' ')
    .trim();
  const text = request ? redactEchoes(cleaned, request) : cleaned;
  if (!text) return undefined;
  return text.length > providerMessageLimit ? `${text.slice(0, providerMessageLimit - 1)}…` : text;
}

// A run this long that also appears in the request is treated as echoed request content.
const echoMinimum = 12;

/** Providers sometimes quote the request in their error; any long run of words copied from it is replaced. */
function redactEchoes(text: string, request: string): string {
  const words = text.split(' ');
  const kept: string[] = [];
  for (let start = 0; start < words.length;) {
    let end = start - 1;
    let phrase = '';
    while (end + 1 < words.length) {
      const longer = phrase ? `${phrase} ${words[end + 1]}` : (words[end + 1] ?? '');
      if (!request.includes(longer)) break;
      phrase = longer;
      end++;
    }
    if (phrase.length >= echoMinimum) {
      if (kept.at(-1) !== '[text]') kept.push('[text]');
      start = end + 1;
    } else {
      kept.push(words[start] ?? '');
      start++;
    }
  }
  return kept.join(' ');
}

/** What a failed model call reports to logs and telemetry. */
export type ModelCallDiagnostics = {
  errorClass: ModelErrorClass;
  /** HTTP status of the provider response; absent when no response arrived. */
  status?: number | undefined;
  providerCode?: string | undefined;
  /** Already sanitised. Logs only; never a span attribute or label. */
  providerMessage?: string | undefined;
  /** Whether any answer text was produced before the call failed. */
  outputStarted: boolean;
};

/**
 * A failed model call. The message stays `model-<reason>` so stored turn codes and callers are unchanged, and
 * `code` is the bounded class that becomes `error.code`.
 */
export class ModelCallError extends Error {
  readonly code: ModelErrorClass;
  readonly reason: string;
  readonly modelDiagnostics: ModelCallDiagnostics;
  constructor(
    reason: string,
    diagnostics: Omit<ModelCallDiagnostics, 'errorClass'> & {
      errorClass?: ModelErrorClass;
      /** The serialized request, used only to redact provider messages that quote it; never stored. */
      request?: string | undefined;
    },
    options?: { cause?: unknown },
  ) {
    super(`model-${reason}`, options);
    this.name = 'ModelCallError';
    this.reason = reason;
    this.code = diagnostics.errorClass ?? modelErrorClass(`model-${reason}`) ?? 'unknown';
    this.modelDiagnostics = {
      errorClass: this.code,
      outputStarted: diagnostics.outputStarted,
      ...(diagnostics.status === undefined ? {} : { status: diagnostics.status }),
      ...(safeProviderCode(diagnostics.providerCode)
        ? { providerCode: safeProviderCode(diagnostics.providerCode) }
        : {}),
    };
    const message = sanitizeProviderMessage(diagnostics.providerMessage, diagnostics.request);
    if (message) this.modelDiagnostics.providerMessage = message;
  }
}

/** The diagnostics of a model call failure anywhere in an error's cause chain. */
export function modelCallDiagnostics(error: unknown): ModelCallDiagnostics | undefined {
  for (let value = error, depth = 0; value && typeof value === 'object' && depth < 8; depth++) {
    if (value instanceof ModelCallError) return value.modelDiagnostics;
    value = (value as { cause?: unknown }).cause;
  }
  return undefined;
}
