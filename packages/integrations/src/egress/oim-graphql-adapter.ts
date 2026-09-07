import type { OimManifest } from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterCredentials,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import { type OimHookPhaseRunner, runOimHookPhase } from "../oim-hooks";
import { GraphqlToolAdapter } from "./graphql-adapter";
import type { GraphqlOperationBinding } from "./graphql-compile";
import { projectResponse, redactCredentialFields } from "./oim-response";
import type { EgressHttpPort } from "./openapi-adapter";

export interface OimGraphqlToolAdapterDeps {
  readonly binding: GraphqlOperationBinding;
  readonly http: EgressHttpPort;
  readonly manifest: Pick<OimManifest, "hooks">;
  readonly hookRunner?: OimHookPhaseRunner;
  readonly projection?: readonly string[];
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
    const raw = await this.delegate.dispatch(request, credential, credentials);
    const redacted = redactCredentialFields(raw);
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

    if (this.deps.projection === undefined) return normalized;
    if (normalized === null || typeof normalized !== "object") {
      throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
    }
    return projectResponse(normalized, this.deps.projection);
  }
}
