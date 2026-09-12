import { canonicalHash, type OimManifest, type OimPagination } from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterCredentials,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import { type OimHookPhaseRunner, runOimHookPhase } from "../oim-hooks";
import { GraphqlToolAdapter } from "./graphql-adapter";
import type { GraphqlOperationBinding } from "./graphql-compile";
import {
  DEFAULT_OIM_PAGINATION_BOUNDS,
  NEXT_PAGE_TOKEN_PROPERTY,
  nextPageToken,
  OimPaginationError,
  type OimPaginationRuntime,
  PAGE_TOKEN_ARGUMENT,
  prepareOimPagination,
} from "./oim-pagination";
import { projectResponse, redactCredentialFields } from "./oim-response";
import type { EgressHttpPort } from "./openapi-adapter";

export interface OimGraphqlToolAdapterDeps {
  readonly binding: GraphqlOperationBinding;
  readonly http: EgressHttpPort;
  readonly manifest: Pick<OimManifest, "hooks">;
  readonly hookRunner?: OimHookPhaseRunner;
  readonly projection?: readonly string[];
  readonly pagination?: OimPagination;
  readonly paginationRuntime?: OimPaginationRuntime;
  readonly toolId?: string;
}

/** OIM GraphQL response boundary: classify, redact, normalize, then project. */
export class OimGraphqlToolAdapter implements ToolAdapter {
  readonly kind = "graphql" as const;
  private readonly delegate: GraphqlToolAdapter;

  constructor(private readonly deps: OimGraphqlToolAdapterDeps) {
    this.delegate = new GraphqlToolAdapter({ binding: deps.binding, http: deps.http });
  }

  async dispatch(
    request: ToolAdapterRequest,
    credential?: string,
    credentials?: ToolAdapterCredentials
  ): Promise<unknown> {
    const arguments_ = request.intent.arguments;
    if (arguments_ === null || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    const variables = { ...(arguments_ as Record<string, unknown>) };
    const suppliedToken = variables[PAGE_TOKEN_ARGUMENT];
    delete variables[PAGE_TOKEN_ARGUMENT];
    const toolId = this.deps.toolId ?? request.intent.toolId;
    const pagination = this.deps.pagination;
    if (
      pagination !== undefined &&
      pagination.type !== "link" &&
      pagination.type !== "body_cursor"
    ) {
      delete variables[pagination.requestParameter];
    }
    const context =
      pagination === undefined
        ? undefined
        : {
            toolId,
            scope: canonicalHash({
              toolId,
              binding: this.deps.binding,
              pagination,
              paginationBounds: DEFAULT_OIM_PAGINATION_BOUNDS,
              projection: this.deps.projection ?? null,
              businessId: request.intent.businessId,
              filePrincipalId: request.intent.filePrincipalId ?? null,
              credentialRef: request.intent.credentialRef ?? null,
            }),
            pagination,
            baseUrl: this.deps.binding.url,
          };
    if (context !== undefined && suppliedToken !== undefined && typeof suppliedToken !== "string") {
      throw new AdapterDispatchError("before_dispatch", "invalid_page_token", false);
    }
    const paginationSession =
      context === undefined
        ? undefined
        : await (async () => {
            const runtime = this.deps.paginationRuntime;
            if (runtime === undefined) {
              throw new AdapterDispatchError(
                "before_dispatch",
                "pagination_runtime_missing",
                false
              );
            }
            try {
              return await prepareOimPagination(
                context,
                typeof suppliedToken === "string" ? suppliedToken : undefined,
                runtime
              );
            } catch (error) {
              if (error instanceof OimPaginationError) {
                throw new AdapterDispatchError("before_dispatch", error.code, false);
              }
              throw error;
            }
          })();
    if (paginationSession?.resume !== undefined && pagination !== undefined) {
      try {
        const resume = paginationSession.resume;
        if (!("parameter" in resume)) throw new OimPaginationError("invalid_page_token");
        if (pagination.type === "page") {
          const page = Number(resume.value);
          if (!Number.isSafeInteger(page) || page < 0) {
            throw new OimPaginationError("invalid_page_token");
          }
          variables[resume.parameter] = page;
        } else {
          variables[resume.parameter] = resume.value;
        }
      } catch (error) {
        if (error instanceof OimPaginationError) {
          throw new AdapterDispatchError("before_dispatch", error.code, false);
        }
        throw error;
      }
    } else if (pagination?.type === "page") {
      variables[pagination.requestParameter] = pagination.start ?? 1;
    }

    const raw = await this.delegate.dispatchDetailed(
      request,
      credential,
      { variables },
      credentials
    );
    const redacted = redactCredentialFields(raw.body);
    let normalized: unknown = redacted;

    try {
      const hookResult = await runOimHookPhase({
        manifest: this.deps.manifest,
        kind: "response_normalize",
        input: { payload: redacted, safeHeaders: {} },
        ...(this.deps.hookRunner === undefined ? {} : { runner: this.deps.hookRunner }),
      });
      if (hookResult.executed) normalized = hookResult.value;
    } catch {
      throw new AdapterDispatchError("after_dispatch", "response_normalize_hook_failed", false);
    }

    let output: unknown = normalized;
    if (this.deps.projection !== undefined) {
      if (normalized === null || typeof normalized !== "object") {
        throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
      }
      output = projectResponse(normalized, this.deps.projection);
    }
    if (context === undefined) return output;
    if (paginationSession === undefined || this.deps.paginationRuntime === undefined) {
      throw new AdapterDispatchError("after_dispatch", "pagination_runtime_missing", false);
    }
    let token: string | undefined;
    try {
      token = await nextPageToken(
        context,
        paginationSession,
        raw.body,
        raw.headers,
        this.deps.paginationRuntime
      );
    } catch (error) {
      if (error instanceof OimPaginationError) {
        throw new AdapterDispatchError("after_dispatch", error.code, false);
      }
      throw error;
    }
    if (token === undefined) return output;
    if (output === null || typeof output !== "object" || Array.isArray(output)) {
      throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
    }
    return { ...(output as Record<string, unknown>), [NEXT_PAGE_TOKEN_PROPERTY]: token };
  }
}
