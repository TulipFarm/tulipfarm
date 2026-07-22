export type FailurePhase = "before" | "after";

export interface FailureHit<Boundary extends string> {
  boundary: Boundary;
  phase: FailurePhase;
  occurrence: number;
}

export class InjectedFailure<Boundary extends string = string> extends Error {
  readonly code = "TESTKIT_INJECTED_FAILURE";

  constructor(
    readonly boundary: Boundary,
    readonly phase: FailurePhase,
    readonly occurrence: number
  ) {
    super(`injected failure ${phase} durable boundary ${boundary} at occurrence ${occurrence}`);
    this.name = "InjectedFailure";
  }
}

function hitKey(boundary: string, phase: FailurePhase): string {
  return `${boundary}:${phase}`;
}

function planKey(boundary: string, phase: FailurePhase, occurrence: number): string {
  return `${hitKey(boundary, phase)}:${occurrence}`;
}

export class FailureInjector<Boundary extends string> {
  private readonly boundaries: ReadonlySet<Boundary>;
  private readonly hits = new Map<string, number>();
  private readonly plan = new Set<string>();

  constructor(boundaries: readonly Boundary[]) {
    if (boundaries.length === 0 || boundaries.some((boundary) => boundary.length === 0)) {
      throw new TypeError("FailureInjector requires declared durable boundaries");
    }
    if (new Set(boundaries).size !== boundaries.length) {
      throw new TypeError("FailureInjector durable boundaries must be unique");
    }
    this.boundaries = new Set(boundaries);
  }

  failAt(boundary: Boundary, phase: FailurePhase, occurrence = 1): void {
    this.assertBoundary(boundary);
    if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
      throw new RangeError("Failure occurrence must be a positive integer");
    }
    if (occurrence <= this.hitCount(boundary, phase)) {
      throw new RangeError("Failure occurrence has already passed");
    }
    this.plan.add(planKey(boundary, phase, occurrence));
  }

  assertDrained(): void {
    if (this.plan.size > 0) {
      throw new Error(`unconsumed failure plan: ${[...this.plan].sort().join(", ")}`);
    }
  }

  hitCount(boundary: Boundary, phase: FailurePhase): number {
    this.assertBoundary(boundary);
    return this.hits.get(hitKey(boundary, phase)) ?? 0;
  }

  before(boundary: Boundary): void {
    this.checkpoint(boundary, "before");
  }

  after(boundary: Boundary): void {
    this.checkpoint(boundary, "after");
  }

  async runAround<Result>(boundary: Boundary, operation: () => Promise<Result>): Promise<Result> {
    this.before(boundary);
    const result = await operation();
    this.after(boundary);
    return result;
  }

  private checkpoint(boundary: Boundary, phase: FailurePhase): void {
    this.assertBoundary(boundary);
    const key = hitKey(boundary, phase);
    const occurrence = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, occurrence);
    const failureKey = planKey(boundary, phase, occurrence);
    if (this.plan.delete(failureKey)) {
      throw new InjectedFailure(boundary, phase, occurrence);
    }
  }

  private assertBoundary(boundary: Boundary): void {
    if (!this.boundaries.has(boundary)) {
      throw new TypeError(`undeclared durable boundary: ${boundary}`);
    }
  }
}
