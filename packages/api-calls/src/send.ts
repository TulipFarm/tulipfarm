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
  type ApiCallResult,
  type ApiRequestCall,
  type SecretHandle,
} from './contracts.ts';
import { encodeBody, normalizeApiUrl, requestHeaders } from './policy.ts';
import { readResponse } from './response.ts';

/** How the caller finds and records the secrets a call names. It throws `ApiCallError` or `SecretError`. */
export type ApiCallSecrets = {
  resolve(
    handle: SecretHandle,
    url: string,
  ): Promise<{ secretId: string; name: string; placement: Placement; value: SecretValue }>;
  recordUse(secretId: string, url: string): Promise<void>;
};

export type SendApiCallOptions = {
  workspaceId: string;
  /** The chat turn or task run the call belongs to, for the per-turn limit. */
  scope: string;
  /** Absent when secrets are not available here; a call that names one then fails with `disabled`. */
  secrets?: ApiCallSecrets | undefined;
  signal?: AbortSignal | undefined;
  dependencies?: PinnedRequestPolicy['dependencies'];
};

const failed = (error: ApiCallError): ApiCallResult => ({
  status: 'failed',
  code: error.code,
  message: error.message,
  ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
  ...(error.secret !== undefined ? { secret: error.secret } : {}),
});

const scopes = new Map<string, number>();
function countCall(scope: string) {
  const count = (scopes.get(scope) ?? 0) + 1;
  scopes.delete(scope);
  scopes.set(scope, count);
  if (scopes.size > 10_000) scopes.delete(scopes.keys().next().value!);
  if (count > API_CALL_LIMITS.callsPerScope)
    throw new ApiCallError(
      'call-limit',
      `This turn already made ${API_CALL_LIMITS.callsPerScope} API calls. Answer with what you have.`,
    );
}

type Slots = { active: number; waiting: (() => void)[] };
const workspaces = new Map<string, Slots>();
async function acquire(workspaceId: string, deadline: number, signal?: AbortSignal) {
  let slots = workspaces.get(workspaceId);
  if (!slots) workspaces.set(workspaceId, (slots = { active: 0, waiting: [] }));
  const current = slots;
  if (current.active < API_CALL_LIMITS.inFlightPerWorkspace) current.active++;
  else
    await new Promise<void>((resolve, reject) => {
      const give = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abandon);
        resolve();
      };
      const abandon = () => {
        clearTimeout(timer);
        current.waiting.splice(current.waiting.indexOf(give), 1);
        reject(new ApiCallError('timeout', 'Too many API calls are running in this workspace. Try again shortly.'));
      };
      const timer = setTimeout(abandon, Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', abandon, { once: true });
      current.waiting.push(give);
    });
  return () => {
    const next = current.waiting.shift();
    if (next) next();
    else if (--current.active === 0) workspaces.delete(workspaceId);
  };
}

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

function parse(input: unknown): ApiRequestCall {
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

/**
 * Sends one `api.request` call. Expected failures are returned as `{ status: 'failed' }`, never thrown. Only `GET`
 * and `HEAD` are sent; every other method needs an approval, which is not available yet.
 */
export async function sendApiCall(input: unknown, options: SendApiCallOptions): Promise<ApiCallResult> {
  let call: ApiRequestCall;
  let request: OutgoingRequest;
  try {
    call = parse(input);
    const url = normalizeApiUrl(call.url, call.query);
    const encoded = call.body ? encodeBody(call.body) : undefined;
    request = {
      url: url.href,
      headers: { ...requestHeaders(call.headers), ...(encoded ? { 'content-type': encoded.contentType } : {}) },
      ...(encoded ? { body: encoded.body } : {}),
    };
    if (!readMethods.has(call.method))
      throw new ApiCallError(
        'approval-unavailable',
        `${call.method} changes data and needs the member's approval, which is not available yet. Nothing was sent. Tell the member.`,
      );
    countCall(options.scope);
  } catch (error) {
    if (error instanceof ApiCallError) return failed(error);
    throw error;
  }

  const handles = call.secrets ?? [];
  const used: { secretId: string; name: string; placement: Placement }[] = [];
  const sent: string[] = [];
  try {
    if (handles.length && !options.secrets)
      throw new ApiCallError('disabled', secretMessages.disabled, {
        secret: 'reference' in handles[0]! ? handles[0].reference : handles[0]!.variable,
      });
    const unplaced = request.url;
    for (const handle of handles) {
      const label = 'reference' in handle ? handle.reference : handle.variable;
      let secret: Awaited<ReturnType<ApiCallSecrets['resolve']>>;
      try {
        secret = await options.secrets!.resolve(handle, unplaced);
        if (secret.placement.kind === 'body' && (readMethods.has(call.method) || call.body?.kind === 'text'))
          throw new SecretError('placement-unsupported');
        request = applyPlacement(request, secret.placement, secret.value, placementKinds);
      } catch (error) {
        throw secretFailure(error, label);
      }
      used.push({ secretId: secret.secretId, name: secret.name, placement: secret.placement });
      sent.push(...valueParts(secret.value));
    }
  } catch (error) {
    if (error instanceof ApiCallError) return failed(error);
    throw error;
  }

  const placements = used.map(secret => secret.placement);
  const timeoutSeconds = call.timeoutSeconds ?? API_CALL_LIMITS.timeoutSeconds.default;
  const deadline = Date.now() + timeoutSeconds * 1000;
  const url = new URL(request.url);
  let requestSent = false;
  let release: (() => void) | undefined;
  try {
    release = await acquire(options.workspaceId, deadline, options.signal);
    const started = performance.now();
    const response = await pinnedRequest(
      url,
      { method: call.method, headers: request.headers, body: request.body ?? null, signal: options.signal ?? null },
      {
        redirects: 'manual',
        timeoutMs: Math.max(1, deadline - Date.now()),
        maximumBytes: API_CALL_LIMITS.fileBytes,
        ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      },
    );
    requestSent = true;
    const read = await readResponse(response, { url, placements, sent });
    const durationMs = Math.round(performance.now() - started);
    return {
      status: 'sent',
      method: call.method,
      url: redactUrl(url.href, placements),
      response: { status: read.status, durationMs, headers: read.headers, body: read.body },
      ...(read.authentication ? { authentication: read.authentication } : {}),
      secrets: used.map(({ name, placement }) => ({ name, placement })),
      untrusted: true,
      ...(read.body.kind === 'omitted'
        ? {
            note:
              read.body.reason === 'binary'
                ? 'The body is not text or JSON, so it was not returned. Saving responses as files is not available yet.'
                : 'The body is over 64 KiB, so it was not returned. Narrow the request, for example with paging or filters.',
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof McpNetworkError) {
      requestSent ||= error.requestSent;
      return failed(networkFailure(error, timeoutSeconds));
    }
    if (error instanceof ApiCallError) return failed(error);
    throw error;
  } finally {
    release?.();
    if (requestSent)
      for (const secret of used) await options.secrets!.recordUse(secret.secretId, redactUrl(url.href, placements));
  }
}
