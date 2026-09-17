const DELETE_PLAN_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "id", "version"],
  properties: {
    type: { type: "string", minLength: 1 },
    id: { type: "string", minLength: 1 },
    version: { type: "number" },
  },
} as const;

export const RECORD_DELETE_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "root", "records", "restrictedBy"],
  properties: {
    id: { type: "string", minLength: 1 },
    root: DELETE_PLAN_RECORD_SCHEMA,
    records: {
      type: "array",
      minItems: 1,
      items: DELETE_PLAN_RECORD_SCHEMA,
    },
    restrictedBy: {
      type: "array",
      items: DELETE_PLAN_RECORD_SCHEMA,
    },
  },
} as const;

export const RECORD_DELETE_PREVIEW_TOOL_DECLARATION = {
  name: "record_delete_preview",
  description:
    "Preview deletion before deleting a Record. Returns the exact versioned cascade set and any dependencies that restrict deletion.",
  mutating: false,
  inputSchema: {
    type: "object",
    required: ["type", "id", "version"],
    additionalProperties: false,
    properties: {
      type: { type: "string", minLength: 1 },
      id: { type: "string", minLength: 1 },
      version: { type: "number" },
    },
  },
} as const;

export const RECORD_DELETE_TOOL_DECLARATION = {
  name: "record_delete",
  description:
    "Soft-delete a record. Requires version for optimistic concurrency. When record_delete_preview reports cascade dependencies, pass its exact plan unchanged.",
  mutating: true,
  inputSchema: {
    type: "object",
    required: ["type", "id", "version"],
    additionalProperties: false,
    properties: {
      type: { type: "string", minLength: 1 },
      id: { type: "string", minLength: 1 },
      version: { type: "number", description: "Current record version (optimistic concurrency)." },
      plan: {
        ...RECORD_DELETE_PLAN_SCHEMA,
        description:
          "Exact dependency preview returned by record_delete_preview. Required unchanged for cascade deletion.",
      },
    },
  },
} as const;

export const RECORD_DELETE_TOOL_DECLARATIONS = [
  RECORD_DELETE_PREVIEW_TOOL_DECLARATION,
  RECORD_DELETE_TOOL_DECLARATION,
] as const;
