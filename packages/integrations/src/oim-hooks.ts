import type { OimHook, OimManifest } from "@tulipfarm/schema";

export interface OimHookPhaseInputMap {
  readonly input_validate: {
    readonly operationId: string;
    readonly arguments: unknown;
  };
  readonly request_shape: {
    readonly operationId: string;
    readonly arguments: unknown;
  };
  readonly response_normalize: {
    readonly payload: unknown;
    readonly safeHeaders: Readonly<Record<string, string>>;
  };
  readonly webhook_classify: {
    readonly payload: unknown;
    readonly safeHeaders: Readonly<Record<string, string>>;
  };
  readonly content_map: {
    readonly operationId: string;
    readonly itemId: string;
    readonly payload: unknown;
  };
  readonly acl_map: {
    readonly operationId: string;
    readonly itemId?: string;
    readonly scopeId?: string;
    readonly payload: unknown;
  };
}

export type OimHookKind = keyof OimHookPhaseInputMap;

export interface OimHookPhaseRunner {
  run<K extends OimHookKind>(
    hook: OimHook & { readonly kind: K },
    input: OimHookPhaseInputMap[K]
  ): Promise<unknown>;
}

export type OimHookPhaseResult =
  | { readonly executed: false }
  | { readonly executed: true; readonly value: unknown };

export interface RunOimHookPhaseInput<K extends OimHookKind> {
  readonly manifest: Pick<OimManifest, "hooks">;
  readonly kind: K;
  readonly exportName?: string;
  readonly input: OimHookPhaseInputMap[K];
  readonly runner?: OimHookPhaseRunner;
}

export class OimHookPhaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OimHookPhaseError";
  }
}

function declaredHook<K extends OimHookKind>(
  manifest: Pick<OimManifest, "hooks">,
  kind: K,
  exportName?: string
): (OimHook & { readonly kind: K }) | undefined {
  const matches = (manifest.hooks ?? []).filter(
    (hook): hook is OimHook & { readonly kind: K } => hook.kind === kind
  );

  if (exportName !== undefined) {
    const exact = matches.find((hook) => hook.export === exportName);
    if (exact === undefined) {
      throw new OimHookPhaseError(`${kind} Hook export "${exportName}" is not declared`);
    }
    return exact;
  }

  if (matches.length > 1) {
    throw new OimHookPhaseError(`${kind} Hook declaration is ambiguous`);
  }
  return matches[0];
}

export function hasDeclaredOimHook(
  manifest: Pick<OimManifest, "hooks">,
  kind: OimHookKind
): boolean {
  return (manifest.hooks ?? []).some((hook) => hook.kind === kind);
}

export async function runOimHookPhase<K extends OimHookKind>(
  request: RunOimHookPhaseInput<K>
): Promise<OimHookPhaseResult> {
  const hook = declaredHook(request.manifest, request.kind, request.exportName);
  if (hook === undefined) return { executed: false };
  if (request.runner === undefined) {
    throw new OimHookPhaseError(
      `${request.kind} Hook is declared but no trusted runner is configured`
    );
  }

  return {
    executed: true,
    value: await request.runner.run(hook, request.input),
  };
}
