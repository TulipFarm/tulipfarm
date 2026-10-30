import { modelErrorClass, modelErrorClasses } from './model-errors.ts';

// Only reviewed machine codes may become labels; provider text and user data must not.
const codes = new Set<string>([
  'closed',
  'queue_full',
  'wait_timeout',
  'pool_capacity',
  'stale_credential',
  'incompatible_version',
  'runtime_unavailable',
  'catalog-timeout',
  'catalog-http',
  'catalog-response',
  'catalog-page-limit',
  'catalog-byte-limit',
  'catalog-invalid-json',
  'catalog-invalid-schema',
  'catalog-invalid-timestamp',
  'catalog-cursor-loop',
  'network-failed',
  'address-denied',
  'access-denied',
  'unauthorized',
  'forbidden',
  'not-found',
  'invalid-input',
  'invalid-request',
  'validation-error',
  'rate-limit',
  'rate-limited',
  'too-many-requests',
  'internal-error',
  'service-unavailable',
  'request-aborted',
  'timeout',
  'conflict',
  'disabled',
  'expired',
  'failed',
  'error',
  'blocked',
  'rejected',
  'cancelled',
  'outcome-unknown',
  'unknown',
  'tool-failed',
  'tool-limit',
  'limit',
  'limit-reached',
  'credit-limit',
  'context-limit',
  // Fixed codes a chat turn stores when it ends without an answer.
  'attempts-exhausted',
  'transient-failure',
  'tool-unavailable',
  'credits-exhausted',
  'project-context-too-large',
  'skill-unavailable',
  'compaction-paused',
  'compaction-unavailable',
  'compaction-not-found',
  'plan-budget',
  'task-limit',
  'delegation-depth',
  'delegation-limit',
  'continuation-conflict',
  'idempotency-conflict',
  'version-conflict',
  'generation-conflict',
  'record-conflict',
  'draft-stale',
  'stale-revision',
  'invalid-query',
  'approval-required',
  'review-required',
  'proposal-conflict',
  'stale-proposal',
  'task-read-unsupported',
  'task-run-conflict',
  'task-not-completed',
  'activation-selection-required',
  'recovery-empty',
  'plan-open',
  'plan-closed',
  'plan-not-found',
  'plan-source-unavailable',
  'plan-operation-unavailable',
  'not-starter',
  'budget-lowered',
  'account-disabled',
  'account-conflict',
  'account-unavailable',
  'account-reconnect-required',
  'account-authorization-denied',
  'account-limit-reached',
  'selection-required',
  'selection-conflict',
  'read-unavailable',
  'read-forbidden',
  'read-limit',
  'read-unqualified',
  'batch-conflict',
  'batch-approval-required',
  'batch-unresolved',
  'batch-unavailable',
  'batch-expired',
  'batch-tool-limit',
  'credential-unavailable',
  'discovery-failed',
  'integration-unavailable',
  'integration-blocked',
  'incompatible-tool',
  'oauth-conflict',
  'mcp-unavailable',
  'knowledge-unavailable',
  'google-integration-required',
  'slack-access-required',
  'app-not-in-channel',
  'requester-not-in-channel',
  'provider-unavailable',
  'provider-error',
  'provider-rate-limit',
  'runtime-unavailable',
  'model-request-failed',
  'model-invalid-response',
  'model-request-not-dispatched',
  'conversation-model-unavailable',
  'conversation-model-unpriced',
  'conversation-context-overflow',
  'invalid-package',
  'package-limit',
  'package-mismatch',
  'package-unavailable',
  'import-expired',
  'import-conflict',
  'source-rate-limit',
  'source-unavailable',
  'source-unsupported',
  'source-limit',
  'github-rate-limited',
  'github-unavailable',
  'source-access-revoked',
  'source-changed',
  'no-skills',
  'skill-in-use',
  'skill-archived',
  'invalid-values',
  'duplicate-key',
  'linked-record',
  'stale-generation',
  'table-maintenance',
  'member-table-protected',
  'member-field-protected',
  'member-inactive',
  'member-unavailable',
  'member-link-conflict',
  'member-selection-required',
  'member-profile-pending',
  'member-profile-failed',
  'FST_ERR_VALIDATION',
  'FST_ERR_CTP_BODY_TOO_LARGE',
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_CTP_INVALID_MEDIA_TYPE',
  'FST_ERR_NOT_FOUND',
  'FST_ERR_BAD_STATUS_CODE',
]);

const reasons: Record<string, string> = {
  closed: 'Workspace storage pool is closed',
  queue_full: 'Workspace storage wait queue is full',
  wait_timeout: 'Workspace storage wait or operation deadline exceeded',
  pool_capacity: 'Workspace storage pool capacity reached',
  stale_credential: 'Workspace storage credential is stale',
  incompatible_version: 'Workspace storage schema version is incompatible',
  runtime_unavailable: 'Workspace storage runtime is unavailable',
  'runtime-unavailable': 'Runtime is unavailable',
  'catalog-timeout': 'Registry catalog refresh deadline exceeded',
  'catalog-http': 'Registry catalog returned an unsuccessful HTTP status',
  'catalog-response': 'Registry catalog response could not be read',
  'catalog-page-limit': 'Registry catalog page limit reached',
  'catalog-entry-limit': 'Registry catalog entry limit reached',
  'response-limit': 'MCP response byte limit reached',
  'catalog-byte-limit': 'Registry catalog byte limit reached',
  'catalog-invalid-json': 'Registry catalog returned invalid JSON',
  'catalog-invalid-schema': 'Registry catalog response schema is invalid',
  'catalog-invalid-timestamp': 'Registry catalog timestamp is invalid',
  'catalog-cursor-loop': 'Registry catalog pagination cursor repeated',
  'network-failed': 'Network request failed',
  'export-timeout': 'Telemetry export timed out',
  'export-concurrency-limit': 'Telemetry export concurrency limit reached',
  'export-retry-exhausted': 'Telemetry export retries exhausted',
  'export-empty': 'Telemetry exporter had nothing to send',
  'export-http': 'Telemetry endpoint returned an unsuccessful HTTP status',
  ECONNRESET: 'Network connection was reset',
  ECONNREFUSED: 'Network connection was refused',
  ETIMEDOUT: 'Network connection timed out',
  ENOTFOUND: 'Network hostname could not be resolved',
  EAI_AGAIN: 'Network hostname lookup temporarily failed',
  EPIPE: 'Network connection was closed while writing',
  CERT_HAS_EXPIRED: 'TLS certificate has expired',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate hostname does not match',
  'address-denied': 'Network destination was denied',
  '08001': 'Database connection could not be established',
  '08006': 'Database connection failed',
  '08003': 'Database connection does not exist',
  '28P01': 'Database authentication failed',
  '28000': 'Database authorization failed',
  '42501': 'Database permission denied',
  '42P01': 'Database relation does not exist',
  '42703': 'Database column does not exist',
  '53300': 'Database connection limit reached',
  '53400': 'Database configuration limit exceeded',
  '57014': 'Database query was canceled',
  '55P03': 'Database lock could not be acquired',
  '57P01': 'Database is shutting down',
  '57P02': 'Database crashed',
  '57P03': 'Database cannot accept integrations',
  '25P02': 'Database transaction is already failed',
  '25P03': 'Database idle transaction timeout',
  '25P04': 'Database transaction timeout',
  '40001': 'Database transaction serialization failed',
  '40P01': 'Database deadlock detected',
  '23505': 'Database unique constraint violated',
  '23503': 'Database foreign key constraint violated',
  '23502': 'Database not-null constraint violated',
  '23514': 'Database check constraint violated',
  'table-title-immutable': 'Table titles cannot change after creation',
  'table-name-unavailable': 'A referenced table has no permanent name',
  // Model failures that happen before or around a provider call, so they have no model error class.
  'model-unpriced': 'The selected model has no price',
  'model-family-unavailable': 'The requested model family is not configured',
  'model-context-unavailable': 'Model context could not be assembled',
  'model-budget-exceeded': 'The model call would exceed its budget',
  'model-lease-expired': 'The model call lease expired',
  'model-retry-conflict': 'A model retry conflicted with another attempt',
  'model-policy-revision-conflict': 'The model policy changed during the request',
  'model-provider-response-failed': 'The model provider response could not be read',
  'skill-review-model-unavailable': 'No model is configured for skill review',
  'guide-model-unavailable': 'No model is configured for the public guide',
  'compaction-model-unavailable': 'No model is configured for chat compaction',
  'compaction-model-failed': 'The compaction model call failed',
  'compaction-invalid-summary': 'The compaction model returned an invalid summary',
  'compaction-ineffective': 'Compaction would not reduce the chat context',
  'compaction-unmeasured': 'Chat context size could not be measured for compaction',
};
for (const code of Object.keys(reasons)) codes.add(code);
for (const code of modelErrorClasses) codes.add(code);

const types = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'AccessDenied',
  'StorageUnavailableError',
  'McpNetworkError',
  'ZodError',
  'OTLPExporterError',
]);
const exportMessages: Record<string, string> = {
  'Request Timeout': 'export-timeout',
  'Request timed out': 'export-timeout',
  'Concurrent export limit reached': 'export-concurrency-limit',
  'Concurrency Limit reached': 'export-concurrency-limit',
  'Export failed with retryable status': 'export-retry-exhausted',
  'Nothing to send': 'export-empty',
};
const errorStages = [
  'metadata',
  'catalog-fetch',
  'catalog-parse',
  'catalog-validate',
  'catalog-page',
  'storage-connect',
  'storage-query',
  'cleanup',
  'dispatch',
  'workspace-discovery',
  'catalog-read',
  'maintenance-connect',
  'maintenance-identity',
  'maintenance-settings',
  'maintenance-role',
  'maintenance-transaction',
  'workspace-access',
  'workspace-migration-lock',
  'table-cleanup-authorization',
  'table-cleanup-proposals',
  'table-cleanup-history',
  'table-cleanup-receipts',
  'table-cleanup-generation',
  'table-cleanup-catalog',
  'table-cleanup-generation-data',
  'table-cleanup-drop',
  'table-cleanup-imports',
  'table-cleanup-credentials',
  'table-cleanup-discovery',
  'table-cleanup-member-images',
] as const;
export type ErrorStage = (typeof errorStages)[number];
const stages = new Set<string>(errorStages);
const errorStage = new WeakMap<object, ErrorStage>();

export const chatStages = [
  'resume',
  'claim',
  'context',
  'prepare',
  'compaction',
  'files',
  'model',
  'memory',
  'tool',
  'tool-recovery',
  'delivery',
  'dispatch',
  'recovery',
] as const;
export type ChatStage = (typeof chatStages)[number];
const loggedStages = new Set<string>([...errorStages, ...chatStages]);

export function safeErrorStage(value: unknown): boolean {
  return typeof value === 'string' && loggedStages.has(value);
}

const catalogFields = {
  httpStatus: 'catalog.http_status',
  pageBytes: 'catalog.page_bytes',
  receivedBytes: 'catalog.received_bytes',
  completedPages: 'catalog.completed_pages',
  attempts: 'catalog.attempts',
} as const;

export function safeDiagnosticNumber(key: string, value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    (key === 'http.response.status_code' || key === 'catalog.http_status' ? value >= 100 && value < 600 : value >= 0)
  );
}

export async function withErrorStage<T>(stage: ErrorStage, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (typeof error === 'object' && error !== null && stages.has(stage) && !errorStage.has(error))
      errorStage.set(error, stage);
    throw error;
  }
}
const genericCodes = new Set([
  'error',
  'failed',
  'unknown',
  'internal-error',
  'provider',
  'provider-error',
  'runtime-unavailable',
]);

export function safeErrorReason(value: unknown): boolean {
  return typeof value === 'string' && (codes.has(value) || Object.values(reasons).includes(value));
}

export function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = telemetryErrorCode(error.message);
  if (code) return code;
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  return types.has(name) ? name : 'Error';
}

/** Only reviewed diagnostics cross the telemetry boundary; never copy exception text. */
export function errorAttributes(error: unknown): {
  [key: string]: string | number | undefined;
  'error.type': string;
  'error.code'?: string;
  'error.reason'?: string;
  'error.stage'?: string;
} {
  const result: ReturnType<typeof errorAttributes> = { 'error.type': 'unknown' };
  const seen = new Set<object>();
  function visit(value: unknown, depth: number, inheritedStage?: string) {
    if (value === null || typeof value !== 'object' || depth > 8 || seen.size >= 32 || seen.has(value)) return;
    seen.add(value);
    const item = value as {
      code?: unknown;
      message?: unknown;
      stage?: unknown;
      cause?: unknown;
      errors?: unknown;
      catalogDiagnostics?: unknown;
    };
    const stage = errorStage.get(value) ?? item.stage;
    const selectedStage = typeof stage === 'string' && stages.has(stage) ? stage : inheritedStage;
    if (selectedStage && !result['error.stage'] && !result['error.code']) result['error.stage'] = selectedStage;
    if (item.catalogDiagnostics && typeof item.catalogDiagnostics === 'object') {
      const diagnostics = item.catalogDiagnostics as Record<string, unknown>;
      for (const [field, key] of Object.entries(catalogFields)) {
        const number = diagnostics[field];
        if (safeDiagnosticNumber(key, number) && result[key] === undefined) result[key] = number as number;
      }
    }
    if (result['error.type'] === 'unknown') result['error.type'] = safeErrorType(value);
    const exportHttp =
      value instanceof Error &&
      value.name === 'OTLPExporterError' &&
      typeof item.code === 'number' &&
      Number.isInteger(item.code) &&
      item.code >= 400 &&
      item.code < 600;
    if (exportHttp && typeof item.code === 'number') result['http.response.status_code'] = item.code;
    visit(item.cause, depth + 1, selectedStage);
    if (value instanceof AggregateError && Array.isArray(item.errors)) {
      for (const child of item.errors.slice(0, 8)) visit(child, depth + 1, selectedStage);
    }
    const code =
      telemetryErrorCode(item.code) ??
      telemetryErrorCode(item.message) ??
      (exportHttp ? 'export-http' : undefined) ??
      (value instanceof Error && typeof item.message === 'string' && Object.hasOwn(exportMessages, item.message)
        ? exportMessages[item.message]
        : undefined) ??
      (item.message === 'timeout exceeded when trying to connect' ? 'wait_timeout' : undefined) ??
      grpcCode(value);
    if (code && (!result['error.code'] || genericCodes.has(result['error.code']))) {
      result['error.code'] = code;
      result['error.reason'] = Object.hasOwn(reasons, code) ? reasons[code]! : code;
      result['error.type'] = safeErrorType(value);
      if (selectedStage) result['error.stage'] = selectedStage;
      else delete result['error.stage'];
    }
  }
  try {
    visit(error, 0);
  } catch {
    /* Hostile accessors must not replace the original failure. */
  }
  return result;
}

const grpcCodes: Record<number, string> = { 4: 'timeout', 14: 'service-unavailable' };

/** gRPC service errors (Temporal, OTLP gRPC) carry a numeric status beside `details` and `metadata`. */
function grpcCode(value: object): string | undefined {
  const item = value as { code?: unknown };
  if (!(value instanceof Error) || !('details' in value) || !('metadata' in value)) return undefined;
  return typeof item.code === 'number' && Object.hasOwn(grpcCodes, item.code) ? grpcCodes[item.code] : undefined;
}

/** A reviewed code, or the bounded class of a `model-<reason>` failure so model errors never collapse into `Error`. */
export function telemetryErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return codes.has(value) ? value : modelErrorClass(value);
}
