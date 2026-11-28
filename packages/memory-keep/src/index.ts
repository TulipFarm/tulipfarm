import { z } from 'zod';

/** Why Keep could not answer. None of these is an empty result. */
export type KeepUnavailableReason = 'timeout' | 'unreachable' | 'not_ready' | 'rejected' | 'invalid_response';

export const keepErrorCodes = [
  'invalid',
  'unauthorized',
  'permission_denied',
  'not_found',
  'conflict',
  'payload_too_large',
  'limit_exceeded',
  'budget_exceeded',
  'unavailable',
  'internal',
] as const;
export type KeepErrorCode = (typeof keepErrorCodes)[number];

export type KeepUnavailable = {
  readonly status: 'unavailable';
  readonly reason: KeepUnavailableReason;
  /** Keep's error code, when it answered with one. */
  readonly code?: KeepErrorCode;
};

/** Whether Keep can be used for a workspace. Only `available` means Keep answered. */
export type KeepDependencyState =
  | { readonly status: 'disabled' }
  | { readonly status: 'not_configured' }
  | KeepUnavailable
  | { readonly status: 'available'; readonly version: string };

export type KeepResult<T> = { readonly status: 'ok'; readonly value: T } | KeepUnavailable;

export type KeepScope = { readonly user: string; readonly project?: string };

/** Keep's answer to a memory request. Every refusal is typed; none of them is an empty successful answer. */
export type KeepMemoryResult<T> =
  | KeepResult<T>
  /** The file changed since the expected revision, or exists when a create expected none. */
  | {
      readonly status: 'conflict';
      readonly reason?: string;
      readonly current?: KeepHead;
    }
  | { readonly status: 'not_found' }
  /** Keep refused the request itself, such as a size limit or an invalid path. Retrying will not help. */
  | { readonly status: 'rejected'; readonly code: KeepErrorCode; readonly reason?: string };

export type KeepHead = { readonly revisionId: string; readonly version: string };

export type KeepMemoryFile = {
  readonly memoryId: string;
  readonly path: string;
  readonly revisionId: string;
  readonly version: string;
  readonly isHead: boolean;
  readonly head: KeepHead;
  readonly text: string;
};

export type KeepWriteOutcome = {
  readonly memoryId: string;
  readonly head: KeepHead;
  /** The ledger sequence of this change; it only grows. */
  readonly seq: number;
  readonly changed: boolean;
  readonly replayed: boolean;
  readonly revisionId: string;
};

export type KeepRevision = {
  readonly revisionId: string;
  readonly seq: number;
  readonly change: string;
  readonly createdAt: string;
  readonly version: string;
  readonly path: string;
  readonly isHead: boolean;
};

export type KeepHistory = { readonly memoryId: string; readonly revisions: readonly KeepRevision[] };

export type KeepForgetReceipt = {
  readonly erasureSeq: number;
  readonly filesAffected: readonly string[];
  readonly filesPurged: readonly string[];
  readonly revisionsPurged: number;
};

export type KeepListedFile = {
  readonly memoryId: string;
  readonly path: string;
  readonly revisionId: string;
  readonly version: string;
  readonly trashed: boolean;
  readonly category?: string | null | undefined;
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly updatedAt?: string | undefined;
};

export type KeepMetadataOutcome = KeepWriteOutcome & {
  readonly path: string;
  readonly displayName: string;
  readonly description: string;
};

export type KeepList = { readonly files: readonly KeepListedFile[]; readonly nextAfter: string | null };

/** One file in a scope's memory tree, by path or by id. */
export type KeepTarget = { readonly path: string } | { readonly memoryId: string };

export type KeepMemoryContext = {
  readonly text: string;
  readonly tokens: number;
  readonly scope: string;
  readonly notes: readonly string[];
};

/** One part of a knowledge source, such as a section of a document. Episode ids are unique within the source. */
export type KeepKnowledgeEpisode = {
  readonly id: string;
  readonly text: string;
  readonly speaker?: string;
  readonly occurredAt?: string;
};

export type KeepKnowledgeIngest = {
  readonly sourceId: string;
  readonly replaced: boolean;
  readonly episodesAdded: number;
  readonly episodesUnchanged: number;
};

export type KeepKnowledgeCitation = {
  readonly sourceId: string;
  readonly sourceTitle: string | null;
  /** `<sourceId>#<episode id>`. */
  readonly episodeId: string | null;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly quote: string;
  readonly sourceMetadata: Readonly<Record<string, string>>;
};

export type KeepKnowledgeHit = {
  readonly id: string;
  readonly score: number;
  readonly sourceId: string | null;
  readonly text: string;
  readonly citation: KeepKnowledgeCitation | null;
};

export type KeepKnowledgeSearch = { readonly hits: readonly KeepKnowledgeHit[]; readonly omitted: number };

export type KeepForgetSourceReceipt = { readonly episodes: number; readonly chunks: number };
export type KeepForgetSources = {
  readonly forgotten: readonly { readonly sourceId: string; readonly receipt: KeepForgetSourceReceipt }[];
  /** Ids the scope does not hold. */
  readonly missing: readonly string[];
};

/** The most source ids one `forgetKnowledgeSources` call may list. */
export const keepForgetSourcesLimit = 1000;

/** The most source ids or collections one knowledge request may list. */
export const keepKnowledgeAllowlistLimit = 1000;

export type KeepClientOptions = {
  /** Keep's origin, such as `http://keep:7357`. */
  readonly endpoint: URL;
  /** Bearer token for Keep's memory routes. Never sent to the health route. */
  readonly token?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
};

export const keepDefaultTimeoutMs = 2000;

const readySchema = z.object({ status: z.literal('ready'), version: z.string() });
const errorSchema = z.object({ error: z.object({ code: z.enum(keepErrorCodes) }) });
const contextSchema = z.object({
  text: z.string(),
  tokens: z.number().int().nonnegative(),
  scope: z.string(),
  notes: z.array(z.string()),
});

const headSchema = z.object({ revisionId: z.string(), version: z.string() });
const seqSchema = z.number().int().nonnegative();
const fileSchema = z.object({
  memoryId: z.string(),
  path: z.string(),
  revisionId: z.string(),
  version: z.string(),
  isHead: z.boolean(),
  head: headSchema,
  text: z.string(),
});
const writeSchema = z.object({
  memoryId: z.string(),
  head: headSchema,
  seq: seqSchema,
  changed: z.boolean(),
  replayed: z.boolean(),
  revisionId: z.string(),
});
const metadataSchema = writeSchema.extend({
  path: z.string(),
  displayName: z.string(),
  description: z.string(),
});
const historySchema = z.object({
  memoryId: z.string(),
  revisions: z.array(
    z.object({
      revisionId: z.string(),
      seq: seqSchema,
      change: z.string(),
      createdAt: z.string(),
      version: z.string(),
      path: z.string(),
      isHead: z.boolean(),
    }),
  ),
});
const forgetSchema = z.object({
  receipt: z.object({
    erasureSeq: seqSchema,
    filesAffected: z.array(z.string()),
    filesPurged: z.array(z.string()),
    revisionsPurged: seqSchema,
  }),
});
const listSchema = z.object({
  files: z.array(
    z.object({
      memoryId: z.string(),
      path: z.string(),
      revisionId: z.string(),
      version: z.string(),
      trashed: z.boolean(),
      category: z.string().nullish(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
      updatedAt: z.string().optional(),
    }),
  ),
  nextAfter: z.string().nullable().optional(),
});
const refusalSchema = z.object({
  error: z.object({
    code: z.enum(keepErrorCodes),
    reason: z.string().optional(),
    details: z.object({ current: headSchema.optional() }).passthrough().nullish(),
  }),
});

const ingestSchema = z.object({
  sourceId: z.string(),
  replaced: z.boolean(),
  report: z.object({ episodes_added: z.number().int(), episodes_unchanged: z.number().int() }),
});
const knowledgeHitSchema = z.object({
  item: z.object({ id: z.string() }),
  score: z.number(),
  source_id: z.string().nullish(),
  text: z.string(),
  citation: z
    .object({
      source_id: z.string(),
      source_title: z.string().nullish(),
      episode_id: z.string().nullish(),
      char_start: z.number().int().nullish(),
      char_end: z.number().int().nullish(),
      quote: z.string(),
      source_metadata: z.record(z.string(), z.string()).nullish(),
    })
    .nullish(),
});
const knowledgeSearchSchema = z.object({ hits: z.array(knowledgeHitSchema), omitted: z.number().int().default(0) });
const forgetSourceSchema = z.object({
  receipt: z.object({ episodes: z.number().int(), chunks: z.number().int() }),
});

const forgetSourcesSchema = z.object({
  forgotten: z.array(z.object({ sourceId: z.string(), receipt: forgetSourceSchema.shape.receipt })),
  missing: z.array(z.string()),
});

const target = (value: KeepTarget) => ('path' in value ? { path: value.path } : { memory_id: value.memoryId });

const unavailable = (reason: KeepUnavailableReason, code?: KeepErrorCode): KeepUnavailable =>
  code ? { status: 'unavailable', reason, code } : { status: 'unavailable', reason };

const timedOut = (error: unknown) => error instanceof Error && error.name === 'TimeoutError';

/**
 * A small HTTP client for the open-source Keep memory service. Every failure is a typed `unavailable` state; nothing
 * throws for a missing, slow or refusing service, and the token never appears in a result.
 */
export function createKeepClient(options: KeepClientOptions) {
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? keepDefaultTimeoutMs;

  async function request(
    path: string,
    init: { method: 'GET' } | { method: 'POST'; body: unknown },
  ): Promise<{ readonly response: Response; readonly body: unknown } | KeepUnavailable> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.method === 'POST') {
      headers['content-type'] = 'application/json';
      if (options.token) headers.authorization = `Bearer ${options.token}`;
    }
    try {
      const response = await call(new URL(path, options.endpoint), {
        method: init.method,
        headers,
        ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      try {
        return { response, body: await response.json() };
      } catch (error) {
        return timedOut(error) ? unavailable('timeout') : { response, body: undefined };
      }
    } catch (error) {
      return unavailable(timedOut(error) ? 'timeout' : 'unreachable');
    }
  }

  function refusal(body: unknown): KeepUnavailable {
    const error = errorSchema.safeParse(body);
    if (!error.success) return unavailable('invalid_response');
    const { code } = error.data.error;
    return unavailable(code === 'unavailable' ? 'not_ready' : 'rejected', code);
  }

  return {
    /** `GET /v1/health/ready`: available only when Keep's storage answers. */
    async health(): Promise<KeepDependencyState> {
      const result = await request('/v1/health/ready', { method: 'GET' });
      if ('status' in result) return result;
      const ready = readySchema.safeParse(result.body);
      if (result.response.ok && ready.success) return { status: 'available', version: ready.data.version };
      return result.response.status === 503 ? unavailable('not_ready') : unavailable('invalid_response');
    },

    /** `POST /v1/memory/context`: the standing memory block for a scope, within a token budget. */
    async memoryContext(input: {
      readonly scope: KeepScope;
      readonly query?: string;
      readonly budgetTokens?: number;
      /** Whether workspace knowledge joins the block. Keep's default is true. */
      readonly includeKnowledge?: boolean;
      /** Whether the user's personal memory joins a project's block. Keep's default is true. */
      readonly includePersonal?: boolean;
    }): Promise<KeepResult<KeepMemoryContext>> {
      const result = await request('/v1/memory/context', {
        method: 'POST',
        body: {
          scope: input.scope,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.budgetTokens === undefined ? {} : { budget_tokens: input.budgetTokens }),
          ...(input.includeKnowledge === undefined ? {} : { include_knowledge: input.includeKnowledge }),
          ...(input.includePersonal === undefined ? {} : { include_personal: input.includePersonal }),
        },
      });
      if ('status' in result) return result;
      if (!result.response.ok) return refusal(result.body);
      const context = contextSchema.safeParse(result.body);
      return context.success ? { status: 'ok', value: context.data } : unavailable('invalid_response');
    },

    /** `POST /v1/memory/read`: one file's head, or an exact earlier revision. A trashed file is `not_found`. */
    read: (input: { readonly scope: KeepScope; readonly revisionId?: string } & KeepTarget) =>
      memory('read', fileSchema, {
        scope: input.scope,
        ...target(input),
        ...(input.revisionId === undefined ? {} : { revision_id: input.revisionId }),
      }),

    /**
     * `POST /v1/memory/write`: replaces a file's text. Without `expectedRevisionId` it only creates a file; with one, it
     * is compare-and-swap and a newer head is a `conflict`. A repeated `idempotencyKey` replays the first answer.
     */
    write: (input: {
      readonly scope: KeepScope;
      readonly path: string;
      readonly text: string;
      readonly expectedRevisionId?: string;
      readonly description?: string;
      readonly idempotencyKey?: string;
    }) =>
      memory('write', writeSchema, {
        scope: input.scope,
        path: input.path,
        text: input.text,
        ...(input.expectedRevisionId === undefined ? {} : { expected_revision_id: input.expectedRevisionId }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.idempotencyKey === undefined ? {} : { idempotency_key: input.idempotencyKey }),
      }),

    /** `POST /v1/memory/update_metadata`: renames or redescribes a file under compare-and-swap, as a new revision. */
    updateMetadata: (
      input: {
        readonly scope: KeepScope;
        readonly expectedRevisionId: string;
        readonly displayName?: string;
        readonly description?: string;
      } & KeepTarget,
    ): Promise<KeepMemoryResult<KeepMetadataOutcome>> =>
      memory('update_metadata', metadataSchema, {
        scope: input.scope,
        ...target(input),
        expected_revision_id: input.expectedRevisionId,
        ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
        ...(input.description === undefined ? {} : { description: input.description }),
      }),

    /** `POST /v1/memory/history`: retained revisions, including those of a trashed file. */
    history: (input: { readonly scope: KeepScope } & KeepTarget) =>
      memory('history', historySchema, { scope: input.scope, ...target(input) }),

    /** `POST /v1/memory/undo`: writes an earlier text as a new revision (the previous one by default). */
    undo: (
      input: {
        readonly scope: KeepScope;
        readonly expectedRevisionId: string;
        readonly targetRevisionId?: string;
      } & KeepTarget,
    ) =>
      memory('undo', writeSchema, {
        scope: input.scope,
        ...target(input),
        expected_revision_id: input.expectedRevisionId,
        ...(input.targetRevisionId === undefined ? {} : { target_revision_id: input.targetRevisionId }),
      }),

    /** `POST /v1/memory/delete`: moves a file to the trash, where `restore` can bring it back for 7 days. */
    delete: (input: { readonly scope: KeepScope; readonly expectedRevisionId: string } & KeepTarget) =>
      memory('delete', writeSchema, {
        scope: input.scope,
        ...target(input),
        expected_revision_id: input.expectedRevisionId,
      }),

    /** `POST /v1/memory/restore`: brings a file back from the trash. */
    restore: (input: { readonly scope: KeepScope } & KeepTarget) =>
      memory('restore', writeSchema, { scope: input.scope, ...target(input) }),

    /**
     * `POST /v1/memory/forget`: permanent erasure from every revision and the trash; it cannot be undone. Without
     * `text`, the whole file goes. Without a target, `text` is erased everywhere in the scope.
     */
    forget: (input: {
      readonly scope: KeepScope;
      readonly path?: string;
      readonly memoryId?: string;
      readonly text?: string;
    }): Promise<KeepMemoryResult<KeepForgetReceipt>> =>
      memory('forget', forgetSchema, {
        scope: input.scope,
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.memoryId === undefined ? {} : { memory_id: input.memoryId }),
        ...(input.text === undefined ? {} : { text: input.text }),
      }).then(result => (result.status === 'ok' ? { status: 'ok', value: result.value.receipt } : result)),

    /** `POST /v1/memory/list`: one page of a scope's files. */
    list: (input: {
      readonly scope: KeepScope;
      readonly includeTrashed?: boolean;
      readonly after?: string;
      readonly limit?: number;
    }) =>
      memory('list', listSchema, {
        scope: input.scope,
        ...(input.includeTrashed === undefined ? {} : { include_trashed: input.includeTrashed }),
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }).then(result =>
        result.status === 'ok'
          ? { status: 'ok' as const, value: { files: result.value.files, nextAfter: result.value.nextAfter ?? null } }
          : result,
      ),

    /**
     * `POST /v1/knowledge/ingest`: adds a source's episodes to the scope's corpus. With `replace`, the source's previous
     * revision is swapped out atomically; without it, new episodes are appended and repeated ones are unchanged.
     */
    ingestKnowledge: (input: {
      readonly scope: KeepScope;
      readonly sourceId: string;
      readonly title: string;
      readonly collection: string;
      readonly kind: string;
      readonly episodes: readonly KeepKnowledgeEpisode[];
      readonly metadata?: Readonly<Record<string, string>>;
      readonly replace?: boolean;
    }): Promise<KeepMemoryResult<KeepKnowledgeIngest>> =>
      post('/v1/knowledge/ingest', ingestSchema, {
        scope: input.scope,
        source_id: input.sourceId,
        title: input.title,
        collection: input.collection,
        kind: input.kind,
        episodes: input.episodes.map(episode => ({
          id: episode.id,
          text: episode.text,
          ...(episode.speaker === undefined ? {} : { speaker: episode.speaker }),
          ...(episode.occurredAt === undefined ? {} : { occurred_at: episode.occurredAt }),
        })),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.replace ? { replace: true } : {}),
      }).then(result =>
        result.status === 'ok'
          ? {
              status: 'ok' as const,
              value: {
                sourceId: result.value.sourceId,
                replaced: result.value.replaced,
                episodesAdded: result.value.report.episodes_added,
                episodesUnchanged: result.value.report.episodes_unchanged,
              },
            }
          : result,
      ),

    /**
     * `POST /v1/knowledge/search`: ranked passages from the scope's corpus. Only sources in `sourceIds` (and
     * `collections`, when given) can match; an empty list matches nothing. Each list holds at most
     * {@link keepKnowledgeAllowlistLimit} entries.
     */
    searchKnowledge: (input: {
      readonly scope: KeepScope;
      readonly query: string;
      readonly sourceIds?: readonly string[];
      readonly collections?: readonly string[];
      readonly limit?: number;
      readonly budgetTokens?: number;
    }): Promise<KeepMemoryResult<KeepKnowledgeSearch>> =>
      post('/v1/knowledge/search', knowledgeSearchSchema, {
        scope: input.scope,
        query: input.query,
        ...(input.sourceIds === undefined ? {} : { source_ids: input.sourceIds }),
        ...(input.collections === undefined ? {} : { collections: input.collections }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.budgetTokens === undefined ? {} : { budget_tokens: input.budgetTokens }),
      }).then(result =>
        result.status === 'ok'
          ? {
              status: 'ok' as const,
              value: {
                omitted: result.value.omitted,
                hits: result.value.hits.map(hit => ({
                  id: hit.item.id,
                  score: hit.score,
                  sourceId: hit.source_id ?? hit.citation?.source_id ?? null,
                  text: hit.text,
                  citation: hit.citation
                    ? {
                        sourceId: hit.citation.source_id,
                        sourceTitle: hit.citation.source_title ?? null,
                        episodeId: hit.citation.episode_id ?? null,
                        charStart: hit.citation.char_start ?? null,
                        charEnd: hit.citation.char_end ?? null,
                        quote: hit.citation.quote,
                        sourceMetadata: hit.citation.source_metadata ?? {},
                      }
                    : null,
                })),
              },
            }
          : result,
      ),

    /** `POST /v1/knowledge/forget_source`: erases a source and everything derived only from it. */
    forgetKnowledgeSource: (input: {
      readonly scope: KeepScope;
      readonly sourceId: string;
    }): Promise<KeepMemoryResult<KeepForgetSourceReceipt>> =>
      post('/v1/knowledge/forget_source', forgetSourceSchema, {
        scope: input.scope,
        source_id: input.sourceId,
      }).then(result => (result.status === 'ok' ? { status: 'ok' as const, value: result.value.receipt } : result)),

    /**
     * `POST /v1/knowledge/forget_sources`: erases up to {@link keepForgetSourcesLimit} sources in one pass. A Keep
     * without this route answers `not_found`; it never does otherwise, since unknown ids are listed as `missing`.
     */
    forgetKnowledgeSources: (input: {
      readonly scope: KeepScope;
      readonly sourceIds: readonly string[];
    }): Promise<KeepMemoryResult<KeepForgetSources>> =>
      post('/v1/knowledge/forget_sources', forgetSourcesSchema, {
        scope: input.scope,
        source_ids: input.sourceIds,
      }),
  };

  function memory<T>(route: string, schema: z.ZodType<T>, body: unknown): Promise<KeepMemoryResult<T>> {
    return post(`/v1/memory/${route}`, schema, body);
  }

  async function post<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<KeepMemoryResult<T>> {
    const result = await request(path, { method: 'POST', body });
    if ('status' in result) return result;
    if (result.response.ok) {
      const value = schema.safeParse(result.body);
      return value.success ? { status: 'ok', value: value.data } : unavailable('invalid_response');
    }
    const refused = refusalSchema.safeParse(result.body);
    if (!refused.success) return unavailable('invalid_response');
    const { code, reason, details } = refused.data.error;
    const why = reason === undefined ? {} : { reason };
    switch (code) {
      case 'conflict':
        return { status: 'conflict', ...why, ...(details?.current ? { current: details.current } : {}) };
      case 'not_found':
        return { status: 'not_found' };
      case 'unavailable':
        return unavailable('not_ready', code);
      case 'unauthorized':
      case 'internal':
        return unavailable('rejected', code);
      default:
        return { status: 'rejected', code, ...why };
    }
  }
}

export type KeepClient = ReturnType<typeof createKeepClient>;
export * from './scope.ts';
