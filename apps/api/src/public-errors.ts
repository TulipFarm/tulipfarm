import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccessDenied, WorkspaceMembershipDenied } from '@tulipfarm/access';
import { AgentTaskError } from '@tulipfarm/agents/task-contracts';
import { FileError } from '@tulipfarm/files';
import { TableValidationError } from '@tulipfarm/tables/definition';
import { TableError } from '@tulipfarm/tables/service-contracts';
import { GenerationError } from '@tulipfarm/tables/store';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { fileErrorStatus } from './files.ts';
import { requestBoundaryError } from './security.ts';

/** A refusal the public API reports with its own status and code. */
export class ExternalApiError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413;
  readonly code: string;
  constructor(status: ExternalApiError['status'], code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/** What each code means and what to do next, for codes whose cause does not carry its own message. */
const guidance: Record<string, string> = {
  'not-found': 'Nothing with this id exists, or this token cannot see it.',
  'table-not-found': 'No table with this id, or it was archived. List tables to find current ids.',
  'stale-record':
    'The row changed or was deleted since you read it. Read it again for its current token, decide whether your ' +
    'change still applies, then retry with a new Idempotency-Key.',
  'idempotency-conflict':
    'This Idempotency-Key was already used for a different request. Reuse a key only to retry the identical ' +
    'request; use a new key for a new write.',
  'invalid-values': 'A value does not match its field. Check the field kinds with describe table.',
  'invalid-json': 'The body is not valid JSON.',
  'request-too-large': 'The body is too large: JSON bodies are limited to 1 MiB and file uploads to 10 MiB.',
  'unsupported-media-type': 'Send application/json, or application/octet-stream for a file upload.',
  'file-size': 'Files must be between 1 byte and 10 MiB.',
  'file-conflict': 'A different file was already uploaded with this Idempotency-Key. Use a new key for a new file.',
  'file-quota': 'The workspace has no file storage left.',
  'internal-server-error':
    'Something failed on our side. A write may or may not have been applied: check the requests endpoint, or ' +
    'retry with the same Idempotency-Key.',
  'temporarily-unavailable': 'The workspace is busy. Retry after a short wait with the same Idempotency-Key.',
  'workspace-updating': 'The workspace is being updated. Retry after Retry-After seconds.',
  'write-failed': 'This row could not be written.',
};

export type Problem = { error: { code: string; message?: string; fieldId?: string } };

export function problem(code: string, message?: string, extra: { fieldId?: string } = {}): Problem {
  const text = message ?? guidance[code];
  return { error: { code, ...(text ? { message: text } : {}), ...extra } };
}

type Mapped = { status: number; body: Problem; headers?: [string, string][] };

const fastifyErrors: Record<string, [number, string, string?]> = {
  FST_ERR_CTP_EMPTY_JSON_BODY: [
    400,
    'invalid-json',
    'The body is empty but Content-Type is application/json. Send a JSON object, such as {}.',
  ],
  FST_ERR_CTP_INVALID_JSON_BODY: [400, 'invalid-json'],
  FST_ERR_CTP_BODY_TOO_LARGE: [413, 'request-too-large'],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, 'unsupported-media-type'],
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: [400, 'invalid-request', 'Content-Length does not match the body.'],
};

/** The public API's single error envelope, `{ error: { code, message } }`, for every error it can raise. */
export function publicError(error: unknown): Mapped | null {
  if (error instanceof ExternalApiError)
    return {
      status: error.status,
      body: problem(error.code, error.message === error.code ? undefined : error.message),
    };
  if (error instanceof z.ZodError)
    return {
      status: 400,
      body: problem(
        'invalid-request',
        error.issues
          .slice(0, 5)
          .map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`)
          .join('; '),
      ),
    };
  if (error instanceof TableValidationError)
    return {
      status: 400,
      body: problem(
        'invalid-values',
        error.fieldId ? `Field ${error.fieldId}: ${error.message}` : error.message,
        error.fieldId ? { fieldId: error.fieldId } : {},
      ),
    };
  if (error instanceof AccessDenied || error instanceof WorkspaceMembershipDenied)
    return { status: 404, body: problem('not-found') };
  if ((error instanceof GenerationError || error instanceof TableError) && error.code === 'not-active')
    return { status: 404, body: problem('table-not-found') };
  if (error instanceof GenerationError)
    return { status: error.code === 'not-found' ? 404 : 409, body: problem(error.code) };
  if (error instanceof TableError) return { status: error.status, body: problem(error.code) };
  if (error instanceof FileError) return { status: fileErrorStatus[error.code], body: problem(`file-${error.code}`) };
  if (error instanceof AgentTaskError) return { status: 409, body: problem(error.code) };
  if (error instanceof StorageUnavailableError && error.code === 'disabled')
    return { status: 404, body: problem('not-found') };
  if (typeof error === 'object' && error !== null) {
    const { code, statusCode, validation, message } = error as {
      code?: unknown;
      statusCode?: unknown;
      validation?: unknown;
      message?: unknown;
    };
    const known = typeof code === 'string' ? fastifyErrors[code] : undefined;
    if (known) return { status: known[0], body: problem(known[1], known[2]) };
    if (validation || (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500))
      return {
        status: typeof statusCode === 'number' ? statusCode : 400,
        body: problem('invalid-request', typeof message === 'string' ? message : undefined),
      };
  }
  // Busy or updating storage: the shared mapping decides the status and Retry-After; this API keeps its envelope.
  let status = 0;
  let code = 'temporarily-unavailable';
  const headers: [string, string][] = [];
  const capture = {
    code(value: number) {
      status = value;
      return capture;
    },
    header(name: string, value: unknown) {
      headers.push([name, String(value)]);
      return capture;
    },
    send(body: { error?: unknown }) {
      if (typeof body?.error === 'string') code = body.error;
      return capture;
    },
  };
  if (requestBoundaryError(error, capture as unknown as FastifyReply)) return { status, body: problem(code), headers };
  return null;
}

export function sendProblem(reply: FastifyReply, mapped: Mapped) {
  for (const [name, value] of mapped.headers ?? []) reply.header(name, value);
  return reply.code(mapped.status).send(mapped.body);
}
