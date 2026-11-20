import { keepConfiguration } from '@tulipfarm/config/keep';
import { createKeepClient, type KeepDependencyState, type KeepUnavailable } from '@tulipfarm/memory-keep';
import { isFeatureEnabled, observeCall } from '@tulipfarm/observability';
import type { createPersonalMemoryService } from '@tulipfarm/conversations/personal-memory';

const PROBE_INTERVAL_MS = 60_000;

class KeepUnavailableError extends Error {
  readonly code: string;
  readonly state: KeepUnavailable;
  constructor(state: KeepUnavailable) {
    super('keep-unavailable');
    this.state = state;
    this.name = 'KeepUnavailableError';
    this.code = state.reason === 'timeout' ? 'timeout' : 'service-unavailable';
  }
}

/**
 * The optional Keep memory service, behind the workspace `keep-memory` flag. It only reports availability: personal
 * memory stays the source of truth, and nothing here changes replies, prompts or memory writes.
 */
export function createKeepMemory(
  dependencies: {
    env?: NodeJS.ProcessEnv;
    enabled?: (workspaceId: string) => Promise<boolean>;
    fetch?: typeof fetch;
  } = {},
) {
  const configuration = keepConfiguration(dependencies.env);
  const enabled =
    dependencies.enabled ??
    (workspaceId => isFeatureEnabled('keep-memory', null, { id: workspaceId }, dependencies.env));
  const client =
    configuration.status === 'configured'
      ? createKeepClient({
          endpoint: configuration.endpoint,
          token: configuration.token,
          ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        })
      : undefined;
  let probe: { readonly at: number; readonly state: Promise<KeepDependencyState> } | undefined;

  function health(): Promise<KeepDependencyState> {
    if (!client) return Promise.resolve({ status: 'not_configured' });
    if (probe && Date.now() - probe.at < PROBE_INTERVAL_MS) return probe.state;
    const state = observeCall('dependency', 'keep.health', async () => {
      const result = await client.health();
      if (result.status === 'unavailable') throw new KeepUnavailableError(result);
      return result;
    }).catch((error: unknown): KeepDependencyState =>
      error instanceof KeepUnavailableError ? error.state : { status: 'unavailable', reason: 'unreachable' },
    );
    probe = { at: Date.now(), state };
    return state;
  }

  return {
    /** The workspace's Keep state. Never rejects; `disabled` calls nothing. */
    async state(workspaceId: string): Promise<KeepDependencyState> {
      try {
        if (!(await enabled(workspaceId))) return { status: 'disabled' };
      } catch {
        return { status: 'disabled' };
      }
      return health();
    },
  };
}

export type KeepMemory = ReturnType<typeof createKeepMemory>;

/** Probes Keep after each successful personal memory read, without waiting for it or changing the result. */
export function withKeepProbe(
  service: ReturnType<typeof createPersonalMemoryService>,
  keep: KeepMemory,
): ReturnType<typeof createPersonalMemoryService> {
  return {
    ...service,
    async read(workspaceId, userId) {
      const result = await service.read(workspaceId, userId);
      void keep.state(workspaceId);
      return result;
    },
  };
}
