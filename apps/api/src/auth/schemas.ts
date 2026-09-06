/**
 * `message`/`code` are optional because most handlers never set them, but they must stay
 * declared: Fastify serializes its own schema-validation errors (which always carry both) through
 * this same response schema, and an undeclared field is silently dropped — leaving the client
 * with the generic HTTP reason phrase in `error` and no way to see the real failure.
 */
export const ErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
    code: { type: "string" },
  },
  required: ["error"],
} as const;

export const PublicUserSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string", format: "email" },
    name: { type: ["string", "null"] },
    role: { type: "string", enum: ["admin", "member"] },
    status: { type: "string", enum: ["active", "invited", "disabled"] },
  },
  required: ["id", "email", "name", "role", "status"],
} as const;

/**
 * The caller's own account, admin authority, and allowed navigation paths. `role` is the account's
 * own level and a Role grant never rewrites it, so a client deriving "is an admin" from `role`
 * hides every admin surface from a granted `Owner` (#408).
 */
export const SessionUserSchema = {
  type: "object",
  properties: {
    ...PublicUserSchema.properties,
    isAdmin: { type: "boolean" },
    navigation: {
      type: "object",
      additionalProperties: false,
      properties: { visiblePaths: { type: "array", items: { type: "string" } } },
      required: ["visiblePaths"],
    },
    // Which settings tab the model config was last saved from — absent when the session route
    // has no soulLoader wired (e.g. some test builds). Lets chat hide effort controls in Basic
    // without an admin-gated round trip to /llm-config.
    llmMode: { type: "string", enum: ["basic", "advanced"] },
  },
  required: [...PublicUserSchema.required, "isAdmin", "navigation"],
} as const;

/**
 * An issued invite link. `token` is the credential itself and is returned exactly once, to the
 * admin who asked for it — it is never readable again, because only its hash is stored.
 */
export const InviteSchema = {
  type: "object",
  properties: {
    token: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
  },
  required: ["token", "expiresAt"],
} as const;

export const PublicApiClientSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    clientId: { type: "string" },
    name: { type: "string" },
    ownerUserId: { type: "string" },
    status: { type: "string", enum: ["active", "disabled"] },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    rotatedAt: { type: ["string", "null"], format: "date-time" },
  },
  required: ["id", "clientId", "name", "ownerUserId", "status", "createdAt"],
} as const;

export const PublicTokenSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    userId: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "userId", "name", "prefix", "createdAt"],
} as const;
