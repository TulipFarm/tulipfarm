import {
  SecretError,
  applyPlacement,
  placementKinds,
  redactUrl,
  valueParts,
  type OutgoingRequest,
  type Placement,
  type SecretValue,
} from '@tulipfarm/secrets';
import { McpNetworkError, pinnedRequest, type PinnedRequestPolicy } from '@tulipfarm/workspace-mcp-transport';
import {
  API_CALL_LIMITS,
  ApiCallError,
  apiRequestCallSchema,
  readMethods,
  type ApiCallErrorCode,
  type ApiCallFailed,
  type ApiCallResult,
  type ApiMethod,
  type ApiRequestCall,
  type SecretHandle,
} from './contracts.ts';
import { encodeBody, normalizeApiUrl, requestHeaders } from './policy.ts';
import { readResponse } from './response.ts';

/** How the caller finds and records the secrets a call names. It throws `ApiCallError` or `SecretError`. */
export type ApiCallSecrets = {
  /** With `expected`, a secret whose value or policy changed since the approval fails with `conflict`. */
  resolve(
    handle: SecretHandle,
    url: string,
    expected?: { version: number; policyVersion: number },
  ): Promise<{
    secretId: string;
    name: string;
    placement: Placement;
    value: SecretValue;
    version: number;
    policyVersion: number;
  }>;
  recordUse(secretId: string, url: string): Promise<void>;
};

/** What a call sent or how it ended, kept without the request or response body. */
export type ApiCallOutcome = {
  status: 'sent' | 'failed' | 'conflict' | 'outcome-unknown';
  responseStatus?: number;
  durationMs?: number;
  errorCode?: string;
};

/**
 * Durable records and limits for calls: `start` records a read once its turn or run is under its call limit and a
 * workspace slot is free, waiting for a slot until `deadline`. It throws `ApiCallError` with `call-limit` or `timeout`.
 */
export type ApiCallLedger = {
  start(
    call: { method: ApiMethod; redactedUrl: string; host: string; timeoutMs: number },
    deadline: number,
    signal?: AbortSignal,
  ): Promise<{ finish(outcome: ApiCallOutcome): Promise<void> }>;
};

/**
 * Saves a response body as a file of the chat or task, returning the `source` that `files.read` reads it by, or null
 * when storage is full. `private` is true when the call sent a secret, so only the member who made it may read it.
 */
export type ApiCallFiles = {
  save(file: {
    name: string;
    mediaType: string;
    bytes: Uint8Array;
    url: string;
    private: boolean;
  }): Promise<{ source: string } | null>;
};

export type SendApiCallOptions = {
  workspaceId: string;
  /** Absent when secrets are not available here; a call that names one then fails with `disabled`. */
  secrets?: ApiCallSecrets | undefined;
  /** Records the call and applies the per-turn and per-workspace limits. */
  calls?: ApiCallLedger | undefined;
  signal?: AbortSignal | undefined;
  /** Saves bodies over 64 KiB or binary ones; absent, they are omitted from the result. */
  files?: ApiCallFiles | undefined;
  dependencies?: PinnedRequestPolicy['dependencies'];
};

export const failedResult = (error: ApiCallError): ApiCallFailed => ({
  status: 'failed',
  code: error.code,
  message: error.message,
  ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
  ...(error.secret !== undefined ? { secret: error.secret } : {}),
});
const failed = failedResult;

const secretCodes: Partial<Record<SecretError['code'], ApiCallErrorCode>> = {
  disabled: 'disabled',
  'not-found': 'not-found',
  unavailable: 'unavailable',
  expired: 'expired',
  conflict: 'conflict',
  'destination-denied': 'destination-denied',
  'placement-unsupported': 'placement-unsupported',
  'placement-required': 'placement-unsupported',
  'credential-unavailable': 'credential-unavailable',
};
const secretMessages: Partial<Record<ApiCallErrorCode, string>> = {
  disabled: 'Secrets are not available here. Tell the member; do not ask for the key in chat.',
  'not-found': 'No secret held in this chat or task matches. Use secrets.list, or make one secrets.request.',
  unavailable: 'The secret is suspended or no longer usable. Tell the member.',
  expired: 'The secret has expired. Tell the member before requesting it again.',
  conflict: 'The secret changed while the call was prepared. Make the call again.',
  'destination-denied': "The URL is not one of the secret's destinations. Nothing was sent.",
  'placement-unsupported': 'The secret cannot be placed in this request. Nothing was sent.',
  'credential-unavailable': 'The secret cannot be decrypted. Tell the member.',
};
function secretFailure(error: unknown, name: string): ApiCallError {
  if (error instanceof ApiCallError)
    return error.secret === undefined ? new ApiCallError(error.code, error.message, { secret: name }) : error;
  if (error instanceof SecretError) {
    if (error.code === 'invalid-input')
      return new ApiCallError(
        'invalid-request',
        `The request already sets what secret ${name} sets, in its placement. Remove that header, cookie, query parameter or field.`,
        { secret: name },
      );
    const code = secretCodes[error.code] ?? 'unavailable';
    return new ApiCallError(code, secretMessages[code] ?? code, { secret: name });
  }
  throw error;
}

function networkFailure(error: McpNetworkError, timeoutSeconds: number): ApiCallError {
  if (error.code === 'address-denied' || error.code === 'endpoint-denied')
    return new ApiCallError('address-denied', 'The host resolves to an address that is not allowed. Nothing was sent.');
  if (error.detail === 'dns-failed') return new ApiCallError('dns-failed', 'The host name did not resolve.');
  if (error.detail === 'timeout')
    return new ApiCallError(
      'timeout',
      `No complete response within ${timeoutSeconds} seconds. A read may be repeated.`,
    );
  if (error.detail === 'encoded-response')
    return new ApiCallError('network-failed', 'The server sent a compressed body, which is not accepted.');
  return new ApiCallError(
    'network-failed',
    error.requestSent
      ? 'The connection failed after the request was sent. A read may be repeated.'
      : 'The connection or TLS handshake failed. Nothing was sent.',
  );
}

export function parseApiCall(input: unknown): ApiRequestCall {
  const parsed = apiRequestCallSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiCallError(
      'invalid-request',
      parsed.error.issues
        .slice(0, 5)
        .map(issue => `${issue.path.join('.') || 'call'}: ${issue.message}`)
        .join('; '),
    );
  if (readMethods.has(parsed.data.method) && parsed.data.body)
    throw new ApiCallError('invalid-request', `${parsed.data.method} cannot have a body.`);
  return parsed.data;
}

export type UsedSecret = {
  secretId: string;
  name: string;
  placement: Placement;
  version: number;
  policyVersion: number;
};

/** A call checked and ready to send: the request with secrets placed, and what was used, without values. */
export type PreparedApiCall = {
  call: ApiRequestCall;
  /** The URL with the agent's query but no secret placements. */
  unplaced: string;
  /** The headers and body the agent set, before secrets are placed. */
  headers: Record<string, string>;
  body: string | undefined;
  contentType: string | null;
  request: OutgoingRequest;
  used: UsedSecret[];
  sent: string[];
  redactedUrl: string;
  host: string;
  timeoutMs: number;
};

/**
 * Validates a call, finds each secret and places it, without sending (P9). `expected` gives the versions an approval
 * was made with, by position; a different secret or placement then fails with `conflict`.
 */
export async function prepareApiCall(
  call: ApiRequestCall,
  secrets: ApiCallSecrets | undefined,
  expected?: readonly UsedSecret[],
): Promise<PreparedApiCall> {
  const url = normalizeApiUrl(call.url, call.query);
  const encoded = call.body ? encodeBody(call.body) : undefined;
  const headers = { ...requestHeaders(call.headers), ...(encoded ? { 'content-type': encoded.contentType } : {}) };
  let request: OutgoingRequest = { url: url.href, headers, ...(encoded ? { body: encoded.body } : {}) };
  const handles = call.secrets ?? [];
  const used: UsedSecret[] = [];
  const sent: string[] = [];
  if (handles.length && !secrets)
    throw new ApiCallError('disabled', secretMessages.disabled, {
      secret: 'reference' in handles[0]! ? handles[0].reference : handles[0]!.variable,
    });
  if (expected && expected.length !== handles.length)
    throw new ApiCallError('conflict', 'The approved secrets changed. Nothing was sent.');
  for (const [index, handle] of handles.entries()) {
    const label = 'reference' in handle ? handle.reference : handle.variable;
    const approved = expected?.[index];
    let secret: Awaited<ReturnType<ApiCallSecrets['resolve']>>;
    try {
      secret = await secrets!.resolve(
        handle,
        url.href,
        approved ? { version: approved.version, policyVersion: approved.policyVersion } : undefined,
      );
      if (
        approved &&
        (secret.secretId !== approved.secretId ||
          JSON.stringify(secret.placement) !== JSON.stringify(approved.placement))
      )
        throw new SecretError('conflict');
      if (secret.placement.kind === 'body' && (readMethods.has(call.method) || call.body?.kind === 'text'))
        throw new SecretError('placement-unsupported');
      request = applyPlacement(request, secret.placement, secret.value, placementKinds);
    } catch (error) {
      throw secretFailure(error, label);
    }
    used.push({
      secretId: secret.secretId,
      name: secret.name,
      placement: secret.placement,
      version: secret.version,
      policyVersion: secret.policyVersion,
    });
    sent.push(...valueParts(secret.value));
  }
  const timeoutSeconds = call.timeoutSeconds ?? API_CALL_LIMITS.timeoutSeconds.default;
  return {
    call,
    unplaced: url.href,
    headers,
    body: encoded?.body,
    contentType: encoded?.contentType ?? null,
    request,
    used,
    sent,
    redactedUrl: redactUrl(
      request.url,
      used.map(secret => secret.placement),
    ),
    host: url.host,
    timeoutMs: timeoutSeconds * 1000,
  };
}

/**
 * Sends a prepared call once. A change whose request may have reached the server but gave no response is
 * `outcome-unknown`, never retried (P28).
 */
export async function transmitApiCall(
  prepared: PreparedApiCall,
  options: Pick<SendApiCallOptions, 'secrets' | 'signal' | 'files' | 'dependencies'> & {
    deadline: number;
    started?: () => void;
  },
): Promise<ApiCallResult> {
  const { call, request, used, sent } = prepared;
  const change = !readMethods.has(call.method);
  const placements = used.map(secret => secret.placement);
  const timeoutSeconds = prepared.timeoutMs / 1000;
  const url = new URL(request.url);
  let requestSent = false;
  try {
    const started = performance.now();
    const response = await pinnedRequest(
      url,
      { method: call.method, headers: request.headers, body: request.body ?? null, signal: options.signal ?? null },
      {
        redirects: 'manual',
        timeoutMs: Math.max(1, options.deadline - Date.now()),
        maximumBytes: API_CALL_LIMITS.fileBytes,
        ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      },
    );
    requestSent = true;
    const read = await readResponse(response, { url, placements, sent, files: Boolean(options.files) });
    const redacted = redactUrl(url.href, placements);
    let body = read.body;
    let note: string | undefined;
    if (read.file && body.kind === 'omitted') {
      const saved = await options.files!.save({ ...read.file, url: redacted, private: used.length > 0 });
      if (saved) {
        body = {
          kind: 'file',
          source: saved.source,
          name: read.file.name,
          contentType: body.contentType,
          bytes: read.file.bytes.byteLength,
        };
        note = `The body was saved as a file. Read it with files.read and source ${saved.source}.`;
      } else {
        body = { ...body, reason: 'too-large' };
        note = 'Storage is full, so the body was not saved or returned. Tell the member.';
      }
    } else if (body.kind === 'omitted')
      note =
        body.reason === 'binary'
          ? 'The body is not text or JSON, so it was not returned.'
          : options.files
            ? 'The body is over 10 MiB, so it was not saved or returned. Narrow the request, for example with paging or filters.'
            : 'The body is over 64 KiB, so it was not returned. Narrow the request, for example with paging or filters.';
    const durationMs = Math.round(performance.now() - started);
    return {
      status: 'sent',
      method: call.method,
      url: redacted,
      response: { status: read.status, durationMs, headers: read.headers, body },
      ...(read.authentication ? { authentication: read.authentication } : {}),
      secrets: used.map(({ name, placement }) => ({ name, placement })),
      untrusted: true,
      ...(note ? { note } : {}),
    };
  } catch (error) {
    if (error instanceof McpNetworkError) {
      const reached = error.requestSent;
      requestSent ||= reached;
      if (change && reached)
        return failed(
          new ApiCallError(
            'outcome-unknown',
            'The request may have reached the server, but no response came back. It was not sent again. Tell the member to check the service before trying again.',
          ),
        );
      return failed(networkFailure(error, timeoutSeconds));
    }
    if (error instanceof ApiCallError) return failed(error);
    throw error;
  } finally {
    if (requestSent)
      for (const secret of used) await options.secrets!.recordUse(secret.secretId, redactUrl(url.href, placements));
  }
}

/** The status a stored call ends with for a result. */
export function callOutcome(result: ApiCallResult): ApiCallOutcome {
  if (result.status === 'sent')
    return { status: 'sent', responseStatus: result.response.status, durationMs: result.response.durationMs };
  if (result.httpStatus !== undefined)
    return { status: 'sent', responseStatus: result.httpStatus, errorCode: result.code };
  if (result.code === 'outcome-unknown' || result.code === 'conflict')
    return { status: result.code, errorCode: result.code };
  return { status: 'failed', errorCode: result.code };
}

/**
 * Sends one `GET` or `HEAD` call. Expected failures are returned as `{ status: 'failed' }`, never thrown. Every other
 * method needs the member's approval first, through the approval store; here it fails with `approval-unavailable`.
 * With `files`, a body over 64 KiB and up to 10 MiB, or a binary one, is saved and the result names it.
 */
export async function sendApiCall(input: unknown, options: SendApiCallOptions): Promise<ApiCallResult> {
  let prepared: PreparedApiCall;
  try {
    const call = parseApiCall(input);
    if (!readMethods.has(call.method))
      throw new ApiCallError(
        'approval-unavailable',
        `${call.method} changes data and needs the member's approval, which is not available here. Nothing was sent. Tell the member.`,
      );
    prepared = await prepareApiCall(call, options.secrets);
  } catch (error) {
    if (error instanceof ApiCallError) return failed(error);
    throw error;
  }
  const deadline = Date.now() + prepared.timeoutMs;
  let record: Awaited<ReturnType<ApiCallLedger['start']>> | undefined;
  try {
    record = await options.calls?.start(
      {
        method: prepared.call.method,
        redactedUrl: prepared.redactedUrl,
        host: prepared.host,
        timeoutMs: prepared.timeoutMs,
      },
      deadline,
      options.signal,
    );
  } catch (error) {
    if (error instanceof ApiCallError) return failed(error);
    throw error;
  }
  let result: ApiCallResult | undefined;
  try {
    result = await transmitApiCall(prepared, { ...options, deadline });
    return result;
  } finally {
    // A failed record leaves the row `sending`; its slot frees itself at the deadline.
    await record
      ?.finish(result ? callOutcome(result) : { status: 'failed', errorCode: 'network-failed' })
      .catch(() => undefined);
  }
}
