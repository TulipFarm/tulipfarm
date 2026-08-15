import { ErrorSchema, PublicApiClientSchema, PublicUserSchema } from "../auth/schemas";

export const NullResponseSchema = {
  type: "null",
} as const;

export const OidcStartQuerystringSchema = {
  type: "object",
  properties: {
    redirectTo: { type: "string" },
  },
} as const;

export const OidcCallbackQuerystringSchema = {
  type: "object",
  required: ["code", "state"],
  properties: {
    code: { type: "string" },
    state: { type: "string" },
  },
} as const;

export const OidcCallbackSuccessResponseSchema = {
  type: "object",
  properties: {
    user: PublicUserSchema,
  },
  required: ["user"],
} as const;

export const OidcCallbackRouteSchema = {
  tags: ["auth"],
  querystring: OidcCallbackQuerystringSchema,
  response: {
    200: OidcCallbackSuccessResponseSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    503: ErrorSchema,
  },
} as const;

export const StepUpRequestBodySchema = {
  type: "object",
  required: ["method", "proof"],
  properties: {
    method: { type: "string", enum: ["totp", "passkey"] },
    proof: {},
  },
} as const;

export const StepUpResponseSchema = {
  type: "object",
  properties: {
    mfaVerifiedAt: { type: "string", format: "date-time" },
  },
  required: ["mfaVerifiedAt"],
} as const;

export const StepUpRouteSchema = {
  tags: ["auth"],
  security: [{ sessionCookie: [] }],
  body: StepUpRequestBodySchema,
  response: {
    200: StepUpResponseSchema,
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
  },
} as const;

export const ApiClientListResponseSchema = {
  type: "object",
  properties: {
    clients: { type: "array", items: PublicApiClientSchema },
  },
  required: ["clients"],
} as const;

export const ApiClientListRouteSchema = {
  tags: ["identity"],
  security: [{ sessionCookie: [] }, { bearerToken: [] }],
  response: {
    200: ApiClientListResponseSchema,
    401: ErrorSchema,
    403: ErrorSchema,
  },
} as const;

export const ApiClientCreateBodySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const;

export const ApiClientCreateResponseSchema = {
  type: "object",
  properties: {
    client: PublicApiClientSchema,
    credential: { type: "string" },
  },
  required: ["client", "credential"],
} as const;

export const ApiClientCreateRouteSchema = {
  tags: ["identity"],
  security: [{ sessionCookie: [] }, { bearerToken: [] }],
  body: ApiClientCreateBodySchema,
  response: {
    201: ApiClientCreateResponseSchema,
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
  },
} as const;

export const ApiClientIdParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" },
  },
} as const;

export const ApiClientRotateResponseSchema = {
  type: "object",
  properties: {
    credential: { type: "string" },
  },
  required: ["credential"],
} as const;

export const ApiClientRotateRouteSchema = {
  tags: ["identity"],
  security: [{ sessionCookie: [] }, { bearerToken: [] }],
  params: ApiClientIdParamsSchema,
  response: {
    200: ApiClientRotateResponseSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    404: ErrorSchema,
  },
} as const;

export const ApiClientDisableResponseSchema = {
  type: "object",
  properties: {
    client: PublicApiClientSchema,
  },
  required: ["client"],
} as const;

export const ApiClientDisableRouteSchema = {
  tags: ["identity"],
  security: [{ sessionCookie: [] }, { bearerToken: [] }],
  params: ApiClientIdParamsSchema,
  response: {
    200: ApiClientDisableResponseSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    404: ErrorSchema,
  },
} as const;

export const ExternalLinkSchema = {
  type: "object",
  properties: {
    provider: { type: "string" },
    externalSubject: { type: "string" },
    userId: { type: "string" },
    verifiedAt: { type: "string", format: "date-time" },
  },
  required: ["provider", "externalSubject", "userId", "verifiedAt"],
} as const;

export const ExternalLinkCreateBodySchema = {
  type: "object",
  required: ["provider"],
  properties: {
    provider: { type: "string", minLength: 1 },
  },
} as const;

export const ExternalLinkTokenResponseSchema = {
  type: "object",
  properties: {
    linkToken: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
  },
  required: ["linkToken", "expiresAt"],
} as const;

export const ExternalLinkCreateRouteSchema = {
  tags: ["identity"],
  security: [{ sessionCookie: [] }, { bearerToken: [] }],
  body: ExternalLinkCreateBodySchema,
  response: {
    201: ExternalLinkTokenResponseSchema,
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
  },
} as const;

export const ExternalLinkRedeemBodySchema = {
  type: "object",
  required: ["linkToken", "provider", "externalSubject"],
  properties: {
    linkToken: { type: "string" },
    provider: { type: "string", minLength: 1 },
    externalSubject: { type: "string", minLength: 1 },
  },
} as const;

export const ExternalLinkResponseSchema = {
  type: "object",
  properties: {
    link: ExternalLinkSchema,
  },
  required: ["link"],
} as const;

export const ExternalLinkRedeemRouteSchema = {
  tags: ["identity"],
  security: [{ bearerToken: [] }],
  body: ExternalLinkRedeemBodySchema,
  response: {
    201: ExternalLinkResponseSchema,
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
  },
} as const;

export const ExternalLinkListResponseSchema = {
  type: "object",
  properties: {
    links: { type: "array", items: ExternalLinkSchema },
  },
  required: ["links"],
} as const;

export const ExternalLinkListRouteSchema = {
  tags: ["identity"],
  security: [{ sessionCookie: [] }, { bearerToken: [] }],
  response: {
    200: ExternalLinkListResponseSchema,
    401: ErrorSchema,
    403: ErrorSchema,
  },
} as const;

export const ExternalLinkParamsSchema = {
  type: "object",
  required: ["provider", "externalSubject"],
  properties: {
    provider: { type: "string" },
    externalSubject: { type: "string" },
  },
} as const;

export const ExternalLinkDeleteRouteSchema = {
  tags: ["identity"],
  security: [{ sessionCookie: [] }, { bearerToken: [] }],
  params: ExternalLinkParamsSchema,
  response: {
    204: NullResponseSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    404: ErrorSchema,
  },
} as const;

export const ChannelBindOfferSchema = {
  type: "object",
  properties: {
    slug: { type: "string" },
    senderId: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    account: {
      type: "object",
      properties: {
        userId: { type: "string" },
        email: { type: "string" },
      },
      required: ["userId", "email"],
    },
  },
  required: ["slug", "senderId", "expiresAt", "account"],
} as const;

export const ChannelBindTokenBodySchema = {
  type: "object",
  required: ["token"],
  properties: {
    token: { type: "string", minLength: 1 },
  },
} as const;

export const ChannelBindPreviewRouteSchema = {
  tags: ["identity"],
  security: [{ sessionCookie: [] }, { bearerToken: [] }],
  body: ChannelBindTokenBodySchema,
  response: {
    200: ChannelBindOfferSchema,
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
  },
} as const;

export const ChannelBindConfirmRouteSchema = {
  tags: ["identity"],
  security: [{ sessionCookie: [] }, { bearerToken: [] }],
  body: ChannelBindTokenBodySchema,
  response: {
    201: ExternalLinkResponseSchema,
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
  },
} as const;
