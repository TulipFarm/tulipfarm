import type {
  ToolDispatchPort,
  ToolDispatchRequest,
  ToolDispatchResult,
} from "@tulipfarm/agent-runtime";
import type { HostedToolResult, TurnAuthority } from "@tulipfarm/tool-host";
import type { LocalToolHost } from "./local-host";

/** Fetches the Run-derived authority for one Turn. Only the control plane may answer this. */
export interface TurnAuthoritySource {
  authority(runId: string): Promise<TurnAuthority | undefined>;
}

/**
 * Routes each Tool call to whichever host can answer it.
 *
 * Co-locating execution must not co-locate the decision about what a Run may do: authority is
 * still derived by the control plane from the Run row, fetched once per Run and reused for that
 * Run's calls. So a locally hosted Tool costs one authority read instead of one round trip per
 * call, and every other Tool takes the unchanged control-plane path.
 */
export class RoutingToolDispatch implements ToolDispatchPort {
  private readonly authorities = new Map<string, Promise<TurnAuthority | undefined>>();

  constructor(
    private readonly local: LocalToolHost,
    private readonly source: TurnAuthoritySource,
    private readonly remote: ToolDispatchPort,
    private readonly log: { warn(obj: unknown, msg?: string): void }
  ) {}

  async dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
    if (!this.local.hostedNames.has(request.name)) return this.remote.dispatch(request);
    if (!(await this.local.ready(request.name))) {
      this.log.warn({ tool: request.name }, "local host not ready; dispatching over the API");
      return this.remote.dispatch(request);
    }

    const authority = await this.authorityFor(request.runId);
    if (authority === undefined) {
      // The Run no longer names a Turn we may act for. The control plane owns that answer.
      return this.remote.dispatch(request);
    }
    if (authority.businessId !== request.businessId) {
      // The Run and the control plane disagree on whose deployment this is. Executing here would
      // pick a side; the API is the one that can tell which.
      this.log.warn({ runId: request.runId }, "authority business mismatch; dispatching over API");
      return this.remote.dispatch(request);
    }

    const result = await this.local.dispatcher.dispatch(authority, {
      callId: request.callId,
      name: request.name,
      arguments: request.arguments,
      ...(request.activeSkillName === undefined
        ? {}
        : { activeSkillName: request.activeSkillName }),
    });
    return withCallId(request.callId, result);
  }

  /** One authority read per Run, so N co-located calls cost one round trip rather than N. */
  private authorityFor(runId: string): Promise<TurnAuthority | undefined> {
    const cached = this.authorities.get(runId);
    if (cached !== undefined) return cached;
    const pending = this.source.authority(runId).catch((error: unknown) => {
      // A failed read must not be cached, and must not deny: fall back to the control plane.
      this.authorities.delete(runId);
      this.log.warn({ err: error, runId }, "authority read failed; dispatching over the API");
      return undefined;
    });
    this.authorities.set(runId, pending);
    return pending;
  }

  /**
   * Drops a Run's cached authority. The composition root calls this when a dispatch attempt
   * settles, so the cache lives for exactly one attempt: a long-lived worker cannot accumulate
   * Run ids, and a Run reclaimed after a park re-reads its authority rather than reusing one
   * read before the park.
   *
   * Callers must not call this while a call for `runId` is still in flight — that only costs an
   * extra read, but it is the reason the hook is at the dispatch boundary and not inside a Tool.
   */
  forget(runId: string): void {
    this.authorities.delete(runId);
  }
}

function withCallId(callId: string, result: HostedToolResult): ToolDispatchResult {
  switch (result.status) {
    case "succeeded":
      return { status: "succeeded", callId, output: result.output };
    case "awaiting_approval":
      return { status: "awaiting_approval", callId, approvalId: result.approvalId };
    case "denied":
      return { status: "denied", callId, reason: result.reason, connectUrl: result.connectUrl };
    default:
      return { status: result.status, callId, reason: result.reason };
  }
}
