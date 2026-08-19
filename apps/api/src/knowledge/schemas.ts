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

/**
 * The Business-wide graph. Typed all the way down, unlike the per-Space graph above: this response
 * is the one place where an extra field on a node would be an unreviewed disclosure about a Page,
 * so the schema is the second gate after the ACL filter.
 */
export const KnowledgeGraphResponseSchema = {
  type: "object",
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          title: { type: "string" },
          spaceId: { type: "string" },
        },
        required: ["id", "path", "title", "spaceId"],
        additionalProperties: false,
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: { sourceId: { type: "string" }, targetId: { type: "string" } },
        required: ["sourceId", "targetId"],
        additionalProperties: false,
      },
    },
    spaces: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
        required: ["id", "name"],
        additionalProperties: false,
      },
    },
    truncated: { type: "boolean" },
  },
  required: ["nodes", "edges", "spaces", "truncated"],
} as const;

export const PageBacklinksResponseSchema = {
  type: "object",
  properties: { items: { type: "array" } },
  required: ["items"],
} as const;

/** Who may read a Page. `kind` is closed: only groupings the product already has. */
export const RestrictionSubjectSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["user", "group", "role"] },
    id: { type: "string", minLength: 1 },
  },
  required: ["kind", "id"],
  additionalProperties: false,
} as const;

export const PageRestrictionResponseSchema = {
  type: "object",
  properties: {
    restricted: { type: "boolean" },
    subjects: { type: "array", items: RestrictionSubjectSchema },
  },
  required: ["restricted", "subjects"],
} as const;

const PrincipalListSchema = { type: "array", items: RestrictionSubjectSchema } as const;

export const PageMoveBodySchema = {
  type: "object",
  properties: {
    spaceId: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

export const PageMovePreviewSchema = {
  type: "object",
  properties: {
    effect: { type: "string", enum: ["widens", "narrows", "mixed", "unchanged"] },
    before: PrincipalListSchema,
    after: PrincipalListSchema,
    gained: PrincipalListSchema,
    lost: PrincipalListSchema,
    ownRestrictionSurvives: { type: ["boolean", "null"] },
    descendants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pageId: { type: "string" },
          path: { type: "string" },
          effect: { type: "string", enum: ["widens", "narrows", "mixed", "unchanged"] },
        },
        required: ["pageId", "path", "effect"],
      },
    },
  },
  required: [
    "effect",
    "before",
    "after",
    "gained",
    "lost",
    "ownRestrictionSurvives",
    "descendants",
  ],
} as const;

/** `minItems: 1` is load-bearing: an empty list would leave a Page no one could read. */
export const SetPageRestrictionBodySchema = {
  type: "object",
  properties: {
    subjects: { type: "array", items: RestrictionSubjectSchema, minItems: 1 },
  },
  required: ["subjects"],
  additionalProperties: false,
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

export const PageVisibilityResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    restricted: { type: "boolean" },
    scope: { type: "string", enum: ["business", "own", "inherited"] },
    own: { type: "array", items: { type: "object", additionalProperties: true } },
    inheritedFrom: { type: "object", additionalProperties: true, nullable: true },
    readers: { type: "array", items: { type: "object", additionalProperties: true } },
  },
  required: ["restricted", "scope", "own", "readers"],
} as const;

export const RestrictionRefusedSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    error: { type: "string" },
    constrainedBy: { type: "object", additionalProperties: true },
  },
  required: ["error"],
} as const;

const DirectorySubjectSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["user", "group", "role"] },
    id: { type: "string" },
    label: { type: "string" },
  },
  required: ["kind", "id", "label"],
} as const;

export const SubjectDirectoryResponseSchema = {
  type: "object",
  properties: {
    users: { type: "array", items: DirectorySubjectSchema },
    teams: { type: "array", items: DirectorySubjectSchema },
    roles: { type: "array", items: DirectorySubjectSchema },
  },
  required: ["users", "teams", "roles"],
} as const;
