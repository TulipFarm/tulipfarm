export const ErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
  required: ["error"],
} as const;

export const PublicUserSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string", format: "email" },
    role: { type: "string", enum: ["admin", "member"] },
    status: { type: "string", enum: ["active", "invited", "disabled"] },
  },
  required: ["id", "email", "role", "status"],
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
