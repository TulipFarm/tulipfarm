import {
  compileRoutine,
  type IdentityCeiling,
  type SimulationFixture,
  type SimulationResult,
  simulateRoutine,
} from "@tulipfarm/run-kernel";
import { routine, type routine as routineSchema } from "@tulipfarm/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type RoutineAuthoringErrorCode =
  | "base_changed"
  | "identity_changed"
  | "invalid_candidate"
  | "not_found"
  | "published_version_immutable"
  | "unauthorized";

export class RoutineAuthoringError extends Error {
  readonly name = "RoutineAuthoringError";

  constructor(readonly code: RoutineAuthoringErrorCode) {
    super(code);
  }
}

export interface RoutineAuthoringAuthority {
  load(slug: string): Promise<{
    readonly definition: routineSchema.RoutineDefinition;
    readonly baseCommit: string;
  } | null>;
  authorize(slug: string, principal: string): Promise<IdentityCeiling | null>;
  proposeChangeset(input: {
    readonly source: "ui";
    readonly path: string;
    readonly content: string;
    readonly expectedBaseCommit: string;
    readonly principal: string;
    readonly businessId: string;
    readonly idempotencyKey: string;
    readonly simulationHash: string;
  }): Promise<{
    readonly changesetId: string;
    readonly status: "validated" | "awaiting_approval" | "published";
  }>;
}

export interface RoutineAuthoringInput {
  readonly slug: string;
  readonly principal: string;
  readonly baseCommit: string;
  readonly yaml: string;
  readonly fixture: SimulationFixture;
}

export interface RoutineAuthoringAnalysis {
  readonly yaml: string;
  readonly validationState: "valid";
  readonly risk: "medium" | "high";
  readonly approval: "required";
  readonly publicationState: "draft";
  readonly simulation: SimulationResult;
}

function validateCandidate(source: string): routineSchema.RoutineDefinition {
  try {
    const parsed: unknown = parseYaml(source);
    return structuredClone(routine.validateRoutineDefinition(parsed).document);
  } catch {
    throw new RoutineAuthoringError("invalid_candidate");
  }
}

/**
 * Strict authoring boundary for canonical Routines. This service can only submit a Soul changeset;
 * it has no direct Soul write or publication capability.
 */
export class CanonicalRoutineAuthoringService {
  constructor(private readonly authority: RoutineAuthoringAuthority) {}

  async load(
    slug: string,
    principal: string
  ): Promise<{
    readonly definition: routineSchema.RoutineDefinition;
    readonly baseCommit: string;
  }> {
    const [current, ceiling] = await Promise.all([
      this.authority.load(slug),
      this.authority.authorize(slug, principal),
    ]);
    if (current === null) throw new RoutineAuthoringError("not_found");
    if (ceiling === null) throw new RoutineAuthoringError("unauthorized");
    return {
      definition: structuredClone(current.definition),
      baseCommit: current.baseCommit,
    };
  }

  async analyze(input: RoutineAuthoringInput): Promise<RoutineAuthoringAnalysis> {
    const [current, ceiling] = await Promise.all([
      this.authority.load(input.slug),
      this.authority.authorize(input.slug, input.principal),
    ]);
    if (current === null) throw new RoutineAuthoringError("not_found");
    if (ceiling === null) throw new RoutineAuthoringError("unauthorized");
    if (current.baseCommit !== input.baseCommit) {
      throw new RoutineAuthoringError("base_changed");
    }

    const candidate = validateCandidate(input.yaml);
    if (
      candidate.metadata.slug !== current.definition.metadata.slug ||
      candidate.metadata.id !== current.definition.metadata.id
    ) {
      throw new RoutineAuthoringError("identity_changed");
    }
    if (
      candidate.metadata.authoredVersion !== current.definition.metadata.authoredVersion + 1 ||
      candidate.metadata.lifecycle !== "draft" ||
      candidate.metadata.publishedDigest !== undefined
    ) {
      throw new RoutineAuthoringError("published_version_immutable");
    }

    try {
      const compiled = compileRoutine(candidate, { identityCeiling: ceiling });
      const simulation = simulateRoutine(compiled, input.fixture);
      const risk = simulation.effects.length > 0 ? "high" : "medium";
      return {
        yaml: stringifyYaml(candidate, { lineWidth: 100 }),
        validationState: "valid",
        risk,
        approval: "required",
        publicationState: "draft",
        simulation,
      };
    } catch {
      throw new RoutineAuthoringError("invalid_candidate");
    }
  }

  async propose(
    input: RoutineAuthoringInput & {
      readonly businessId: string;
      readonly idempotencyKey: string;
    }
  ): Promise<{
    readonly changesetId: string;
    readonly status: "validated" | "awaiting_approval" | "published";
  }> {
    const analysis = await this.analyze(input);
    return this.authority.proposeChangeset({
      source: "ui",
      path: `routines/${input.slug}/routine.yaml`,
      content: analysis.yaml,
      expectedBaseCommit: input.baseCommit,
      principal: input.principal,
      businessId: input.businessId,
      idempotencyKey: input.idempotencyKey,
      simulationHash: analysis.simulation.resultHash,
    });
  }
}
