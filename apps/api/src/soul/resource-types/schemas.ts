export const ResourceTypeValidationErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    boundary: { type: "string" },
    path: { type: "string" },
    affectedRecordIds: { type: "array", items: { type: "string" } },
    affectedRecordCount: { type: "number" },
  },
  required: ["error"],
} as const;

export const ResourceTypeResponseSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    schema: { type: "string" },
    hasHooks: { type: "boolean" },
    revision: { type: "string", pattern: "^[0-9a-f]{40}$" },
    domain: { type: "string" },
  },
  required: ["name", "schema", "hasHooks", "revision"],
} as const;

export const CreateResourceTypeBodySchema = {
  type: "object",
  required: ["name", "schema"],
  properties: {
    name: { type: "string" },
    schema: { type: "string" },
    domain: { type: "string" },
  },
} as const;

export const ListResourceTypesResponseSchema = {
  type: "object",
  properties: {
    types: { type: "array", items: ResourceTypeResponseSchema },
  },
  required: ["types"],
} as const;

export const ResourceTypeNameParamsSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
  },
} as const;

export const UpdateResourceTypeBodySchema = {
  type: "object",
  required: ["schema", "revision"],
  properties: {
    schema: { type: "string" },
    revision: { type: "string", pattern: "^[0-9a-f]{40}$" },
    domain: { type: "string" },
  },
} as const;

export const ResourceTypeDeleteResponseSchema = {
  type: "null",
} as const;

export const ResourceTypeHooksResponseSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    hasHooks: { type: "boolean" },
    source: { type: "string", nullable: true },
  },
  required: ["name", "hasHooks"],
} as const;

export const UpdateResourceTypeHooksBodySchema = {
  type: "object",
  required: ["source"],
  properties: {
    source: { type: "string" },
  },
} as const;

export const ResourceTypeHooksDeleteResponseSchema = {
  type: "null",
} as const;
