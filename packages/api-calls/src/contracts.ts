import { z } from 'zod';
import type { AuthHint, Placement } from '@tulipfarm/secrets';

export const API_CALL_LIMITS = {
  urlCharacters: 4096,
  queryPairs: 50,
  headers: 16,
  headerBytes: 16 * 1024,
  headerValueCharacters: 8192,
  bodyBytes: 1024 * 1024,
  secrets: 5,
  timeoutSeconds: { min: 1, max: 60, default: 30 },
  inlineBytes: 64 * 1024,
  fileBytes: 10 * 1024 * 1024,
  callsPerScope: 50,
  inFlightPerWorkspace: 10,
  purposeCharacters: 500,
} as const;

export const apiMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = (typeof apiMethods)[number];
export const readMethods: ReadonlySet<ApiMethod> = new Set(['GET', 'HEAD']);

const pair = z.strictObject({ name: z.string().min(1).max(256), value: z.string().max(8192) });

export const apiRequestCallSchema = z.strictObject({
  tool: z.literal('api.request'),
  method: z.enum(apiMethods),
  url: z.string().min(1).max(API_CALL_LIMITS.urlCharacters).describe('Full https URL, such as https://host/path?query'),
  query: z
    .array(pair)
    .max(API_CALL_LIMITS.queryPairs)
    .optional()
    .describe('Query parameters, added to the URL in this order.'),
  headers: z
    .record(z.string().min(1).max(64), z.string().max(API_CALL_LIMITS.headerValueCharacters))
    .optional()
    .describe('Request headers. Never credentials: those go only through secrets.'),
  body: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('json'), value: z.json() }),
      z.strictObject({ kind: z.literal('form'), fields: z.array(pair).max(256) }),
      z.strictObject({
        kind: z.literal('text'),
        contentType: z.string().min(1).max(256),
        text: z.string().max(API_CALL_LIMITS.bodyBytes),
      }),
    ])
    .optional()
    .describe('Only for POST, PUT, PATCH and DELETE.'),
  secrets: z
    .array(z.union([z.strictObject({ reference: z.uuid() }), z.strictObject({ variable: z.string().min(1).max(64) })]))
    .max(API_CALL_LIMITS.secrets)
    .optional()
    .describe('Secrets to send, by reference or variable name. Each goes in its saved placement.'),
  timeoutSeconds: z
    .int()
    .min(API_CALL_LIMITS.timeoutSeconds.min)
    .max(API_CALL_LIMITS.timeoutSeconds.max)
    .optional()
    .describe('1 to 60 seconds, 30 by default.'),
  purpose: z.string().max(API_CALL_LIMITS.purposeCharacters).optional().describe('Why this call is made.'),
});
export type ApiRequestCall = z.infer<typeof apiRequestCallSchema>;
export type ApiRequestBody = NonNullable<ApiRequestCall['body']>;
export type SecretHandle = NonNullable<ApiRequestCall['secrets']>[number];

export type ApiCallErrorCode =
  | 'invalid-request'
  | 'credential-in-request'
  | 'address-denied'
  | 'dns-failed'
  | 'network-failed'
  | 'timeout'
  | 'too-large'
  | 'call-limit'
  | 'approval-unavailable'
  | 'rejected'
  | 'expired'
  | 'conflict'
  | 'outcome-unknown'
  | 'disabled'
  | 'not-found'
  | 'unavailable'
  | 'destination-denied'
  | 'placement-unsupported'
  | 'credential-unavailable'
  | 'secret-reflected';

export class ApiCallError extends Error {
  readonly code: ApiCallErrorCode;
  readonly httpStatus: number | undefined;
  readonly secret: string | undefined;
  constructor(code: ApiCallErrorCode, message: string = code, details: { httpStatus?: number; secret?: string } = {}) {
    super(message);
    this.name = 'ApiCallError';
    this.code = code;
    this.httpStatus = details.httpStatus;
    this.secret = details.secret;
  }
}

export type ResponseBody =
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'none' }
  | { kind: 'omitted'; reason: 'too-large' | 'binary'; bytes: number | null; contentType: string | null }
  /** A body saved as a file of the chat or task, read with `files.read` by `source`. */
  | { kind: 'file'; source: string; name: string; contentType: string | null; bytes: number };

export type ApiCallSent = {
  status: 'sent';
  method: ApiMethod;
  url: string;
  response: { status: number; durationMs: number; headers: Record<string, string>; body: ResponseBody };
  authentication?: AuthHint;
  secrets: { name: string; placement: Placement }[];
  /** The host is on the operator's private host list, so only the member who made the call may see the response. */
  privateHost?: true;
  untrusted: true;
  note?: string;
};
export type ApiCallFailed = {
  status: 'failed';
  code: ApiCallErrorCode;
  message: string;
  httpStatus?: number;
  secret?: string;
};
export type ApiCallResult = ApiCallSent | ApiCallFailed;

/** What a tool returns while a change waits for its member's decision. */
export type ApiCallWaiting = { provider: 'api-call'; kind: 'waiting'; callId: string };
export const apiCallWaitingSchema = z.strictObject({
  provider: z.literal('api-call'),
  kind: z.literal('waiting'),
  callId: z.uuid(),
});

const placementResultSchema = z.looseObject({ kind: z.string() });
export const apiCallResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('sent'),
    method: z.enum(apiMethods),
    url: z.string(),
    response: z.strictObject({
      status: z.int(),
      durationMs: z.number(),
      headers: z.record(z.string(), z.string()),
      body: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('json'), value: z.json() }),
        z.strictObject({ kind: z.literal('text'), text: z.string() }),
        z.strictObject({ kind: z.literal('none') }),
        z.strictObject({
          kind: z.literal('omitted'),
          reason: z.enum(['too-large', 'binary']),
          bytes: z.number().nullable(),
          contentType: z.string().nullable(),
        }),
        z.strictObject({
          kind: z.literal('file'),
          source: z.string(),
          name: z.string(),
          contentType: z.string().nullable(),
          bytes: z.int(),
        }),
      ]),
    }),
    authentication: z
      .strictObject({ status: z.int(), challenge: z.string().nullable(), excerpt: z.string().nullable() })
      .optional(),
    secrets: z.array(z.strictObject({ name: z.string(), placement: placementResultSchema })),
    privateHost: z.literal(true).optional(),
    untrusted: z.literal(true),
    note: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    code: z.string(),
    message: z.string(),
    httpStatus: z.int().optional(),
    secret: z.string().optional(),
  }),
]);

export const apiCallStatuses = [
  'awaiting-approval',
  'sending',
  'sent',
  'failed',
  'rejected',
  'expired',
  'conflict',
  'outcome-unknown',
] as const;
export type ApiCallStatus = (typeof apiCallStatuses)[number];

export const apiCallViewSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(apiCallStatuses),
  method: z.enum(apiMethods),
  url: z.string(),
  host: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z
    .strictObject({ contentType: z.string(), preview: z.string(), bytes: z.number().int(), truncated: z.boolean() })
    .nullable(),
  secrets: z.array(z.strictObject({ name: z.string(), placement: z.looseObject({ kind: z.string() }) })),
  purpose: z.string().nullable(),
  digest: z.string().nullable(),
  expiresAt: z.string().nullable(),
  responseStatus: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('chat'), conversationId: z.uuid() }),
    z.strictObject({ kind: z.literal('task'), taskId: z.uuid() }),
  ]),
});
/** `sending` also covers an approved change that has not been claimed yet; `rejected` and `expired` cover undecided ones. */
export type ApiCallView = z.infer<typeof apiCallViewSchema>;

export const apiCallDecisionSchema = z.strictObject({
  commandId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(500).optional(),
});
export type ApiCallDecision = z.infer<typeof apiCallDecisionSchema>;
