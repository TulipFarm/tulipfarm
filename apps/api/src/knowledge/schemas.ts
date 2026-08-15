export const PageResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    version: { type: "number" },
  },
  required: ["id", "version"],
} as const;

export const PageCreateBodySchema = {
  type: "object",
  required: ["title", "content"],
  properties: {
    title: { type: "string", minLength: 1 },
    content: { type: "string" },
    domain: { type: "string", nullable: true },
    tags: { type: "array", items: { type: "string" } },
    alwaysLoadForAgents: { type: "boolean" },
  },
} as const;

export const PageListQuerySchema = {
  type: "object",
  properties: {
    cursor: { type: "string" },
    limit: { type: "number" },
    domain: { type: "string" },
    source: { type: "string" },
    tags: { type: "string" },
  },
} as const;

export const PageListResponseSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: PageResponseSchema },
    nextCursor: { type: "string", nullable: true },
  },
  required: ["items", "nextCursor"],
} as const;

export const PageMentionsResponseSchema = {
  type: "object",
  properties: { items: { type: "array" } },
  required: ["items"],
} as const;

export const EntityIdParamsSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
} as const;

export const PageUpdateBodySchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const NoContentSchema = {
  type: "null",
} as const;

export const PageRevisionCreateBodySchema = {
  type: "object",
  required: ["content"],
  properties: {
    content: { type: "string" },
    reason: { type: "string", nullable: true },
  },
} as const;

export const PageRevisionCreatedResponseSchema = {
  type: "object",
  properties: { revisionNumber: { type: "number" } },
} as const;

export const PageRevisionListResponseSchema = {
  type: "object",
  properties: { items: { type: "array" } },
  required: ["items"],
} as const;

export const SearchBodySchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string" },
    limit: { type: "number" },
    granularity: { type: "string", enum: ["chunk", "page"] },
    domain: { type: "string" },
    source: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    spaceId: { type: "string" },
    type: { type: "string" },
  },
} as const;

export const SearchResponseSchema = {
  type: "object",
  properties: {
    results: { type: "array" },
    warnings: { type: "array" },
  },
  required: ["results", "warnings"],
} as const;

export const SpaceResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: { id: { type: "string" } },
  required: ["id"],
} as const;

export const SpaceCreateBodySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string", nullable: true },
  },
} as const;

export const SpaceListQuerySchema = {
  type: "object",
  properties: {
    cursor: { type: "string" },
    limit: { type: "number" },
  },
} as const;

export const SpaceListResponseSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: SpaceResponseSchema },
    nextCursor: { type: "string", nullable: true },
  },
  required: ["items", "nextCursor"],
} as const;

export const SpaceUpdateBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string", nullable: true },
  },
} as const;

export const SpacePageListResponseSchema = {
  type: "object",
  properties: { items: { type: "array" } },
  required: ["items"],
} as const;

export const SpacePageWriteBodySchema = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: { type: "string", minLength: 1 },
    content: { type: "string", minLength: 1 },
  },
} as const;

export const SpacePageWriteResultSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const SpaceNavigateQuerySchema = {
  type: "object",
  properties: { dirPath: { type: "string" } },
} as const;

export const SpaceNavigateResponseSchema = {
  type: "object",
  properties: { listing: { type: "string" } },
  required: ["listing"],
} as const;

export const SpaceGraphResponseSchema = {
  type: "object",
  properties: {
    nodes: { type: "array" },
    edges: { type: "array" },
    truncated: { type: "boolean" },
  },
  required: ["nodes", "edges", "truncated"],
} as const;

export const PageBacklinksResponseSchema = {
  type: "object",
  properties: { items: { type: "array" } },
  required: ["items"],
} as const;

export const OverviewQuerySchema = {
  type: "object",
  properties: { recentLimit: { type: "number" } },
} as const;

export const OverviewResponseSchema = {
  type: "object",
  properties: {
    spaces: { type: "array" },
    recent: { type: "array" },
  },
  required: ["spaces", "recent"],
} as const;

export const ReindexBodySchema = {
  type: "object",
  properties: {
    pageId: { type: "string" },
    spaceId: { type: "string" },
  },
} as const;

export const ReindexedCountResponseSchema = {
  type: "object",
  properties: { reindexed: { type: "number" } },
  required: ["reindexed"],
} as const;

export const IndexStatusResponseSchema = {
  type: "object",
  additionalProperties: true,
} as const;
