import type {
  OimContinuationCodec,
  OimContinuationState,
  OimPaginationRuntime,
  OimPaginationStyle,
} from "./oim-pagination";

export const OIM_FIXTURE_INPUT_PAGE_TOKEN = "fixture-continuation:input";

export interface OimFixtureContinuationSeed {
  readonly toolId: string;
  readonly style: OimPaginationStyle;
  readonly cursor: string;
  readonly pages?: number;
  readonly items?: number;
  readonly bytes?: number;
  readonly startedAtMs?: number;
}

class FixtureContinuationCodec implements OimContinuationCodec {
  private readonly states = new Map<string, OimContinuationState>();
  private sequence = 0;

  constructor(
    private readonly now: () => number,
    private readonly seed?: OimFixtureContinuationSeed
  ) {}

  async seal(state: OimContinuationState): Promise<string> {
    this.sequence += 1;
    const token = `fixture-continuation:${this.sequence}`;
    this.states.set(token, structuredClone(state));
    return token;
  }

  async unseal(
    token: string,
    expected: Pick<OimContinuationState, "toolId" | "scope" | "style">
  ): Promise<unknown> {
    const state = this.states.get(token);
    if (state !== undefined) return structuredClone(state);
    if (
      token !== OIM_FIXTURE_INPUT_PAGE_TOKEN ||
      this.seed === undefined ||
      this.seed.toolId !== expected.toolId ||
      this.seed.style !== expected.style
    ) {
      throw new Error("unknown fixture continuation");
    }
    return {
      version: 3,
      ...expected,
      cursor: this.seed.cursor,
      progress: {
        pages: this.seed.pages ?? 1,
        items: this.seed.items ?? 0,
        bytes: this.seed.bytes ?? 0,
        startedAtMs: this.seed.startedAtMs ?? this.now(),
      },
    } satisfies OimContinuationState;
  }
}

/**
 * Process-local opaque continuation state for hermetic package fixtures only.
 *
 * Production hosts must provide durable state or authenticated encryption across restarts.
 */
export function createOimFixturePaginationRuntime(
  now: () => number = Date.now,
  seed?: OimFixtureContinuationSeed
): OimPaginationRuntime {
  return { codec: new FixtureContinuationCodec(now, seed), now };
}
