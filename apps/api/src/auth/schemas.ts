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
  },
  required: ["id", "email", "role"],
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
