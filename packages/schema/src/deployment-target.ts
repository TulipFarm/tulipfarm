import { type Static, Type } from "@sinclair/typebox";
import { parse as parseYaml } from "yaml";
import { ajv } from "./ajv";
import { TulipFarmValidationError } from "./error";

/**
 * A target is either something we boot in CI and stand behind (`supported`) or something the
 * manifest describes without that promise (`community`). Keeping the two distinguishable is what
 * lets every surface state the strength of the promise beside the steps, rather than withhold
 * steps it has already rendered.
 */
const TARGET_TIERS = ["supported", "community"] as const;

/**
 * The closed set of ways a step proves it worked. An open set is one an LLM invents into, so a
 * step that has no automated check must say so with `manual` rather than omitting the field.
 */
const VERIFY_KINDS = ["http", "command", "file", "env", "manual"] as const;

/**
 * The closed set of generators that can produce a *generated* artifact. It is closed for the same
 * reason the verify kinds are: a generator name only means something if code exists to satisfy it,
 * and an open set invites a manifest to name one nobody has written.
 */
const ARTIFACT_GENERATORS = ["helm-values", "containerapp"] as const;

export const TARGET_TIER_VALUES = TARGET_TIERS;
export const VERIFY_KIND_VALUES = VERIFY_KINDS;

const NonEmpty = Type.String({ minLength: 1 });

const InputOptionSchema = Type.Object(
  {
    value: NonEmpty,
    label: NonEmpty,
    default: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

/**
 * `when` is the only conditional the manifest has, and its keys may reference only a declared
 * input id — never an expression. That keeps the wizard a finite state machine and keeps the flat
 * prose render decidable. The id/value pairing is checked in {@link deploymentTargetIssues}.
 */
const WhenSchema = Type.Record(Type.String(), NonEmpty);

const InputSchema = Type.Object(
  {
    id: NonEmpty,
    question: NonEmpty,
    options: Type.Array(InputOptionSchema, { minItems: 1 }),
    when: Type.Optional(WhenSchema),
  },
  { additionalProperties: false }
);

const HttpVerifySchema = Type.Object(
  {
    kind: Type.Literal("http"),
    url: NonEmpty,
    expect: Type.Integer({ minimum: 100, maximum: 599 }),
    timeout: Type.Optional(NonEmpty),
  },
  { additionalProperties: false }
);

const CommandVerifySchema = Type.Object(
  {
    kind: Type.Literal("command"),
    command: NonEmpty,
    expect: Type.Optional(NonEmpty),
  },
  { additionalProperties: false }
);

const FileVerifySchema = Type.Object(
  {
    kind: Type.Literal("file"),
    path: NonEmpty,
  },
  { additionalProperties: false }
);

const EnvVerifySchema = Type.Object(
  {
    kind: Type.Literal("env"),
    name: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }),
  },
  { additionalProperties: false }
);

/**
 * `look_for` is required, not optional: a manual step exists precisely because there is nothing to
 * automate, so the words the operator should check for are the only signal it carries.
 */
const ManualVerifySchema = Type.Object(
  {
    kind: Type.Literal("manual"),
    look_for: NonEmpty,
  },
  { additionalProperties: false }
);

const VerifySchema = Type.Union([
  HttpVerifySchema,
  CommandVerifySchema,
  FileVerifySchema,
  EnvVerifySchema,
  ManualVerifySchema,
]);

const StepSchema = Type.Object(
  {
    id: NonEmpty,
    title: NonEmpty,
    when: Type.Optional(WhenSchema),
    body: Type.Optional(Type.String()),
    run: Type.Optional(NonEmpty),
    verify: VerifySchema,
    on_fail: Type.Optional(NonEmpty),
  },
  { additionalProperties: false }
);

/**
 * An artifact is produced one of two ways, and the two are genuinely different contracts:
 *
 * - **Referenced** — a file we hand-maintain, publish byte-identical, and boot in CI (Compose, the
 *   example env file). The target points at the served name; it never carries the bytes, so the
 *   page cannot drift from what CI boots.
 * - **Generated** — a file with no published source, built from the contract by a named generator
 *   (Kubernetes chart values). The renderer emits it, so it too cannot drift from the contract it
 *   is derived from.
 *
 * The wire shape is a union so a manifest declares exactly one kind and a mistyped field fails
 * rather than being silently dropped.
 */
const ReferencedArtifactSchema = Type.Object(
  {
    id: NonEmpty,
    references: NonEmpty,
  },
  { additionalProperties: false }
);

const GeneratedArtifactSchema = Type.Object(
  {
    id: NonEmpty,
    filename: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]*$" }),
    from: Type.Unsafe<(typeof ARTIFACT_GENERATORS)[number]>({
      type: "string",
      enum: [...ARTIFACT_GENERATORS],
    }),
  },
  { additionalProperties: false }
);

const ArtifactSchema = Type.Union([ReferencedArtifactSchema, GeneratedArtifactSchema]);

export const DeploymentTargetSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    title: NonEmpty,
    tier: Type.Unsafe<(typeof TARGET_TIERS)[number]>({ type: "string", enum: [...TARGET_TIERS] }),
    description: Type.String({ minLength: 50, maxLength: 160 }),
    summary: NonEmpty,
    inputs: Type.Optional(Type.Array(InputSchema, { minItems: 1 })),
    steps: Type.Array(StepSchema, { minItems: 1 }),
    artifacts: Type.Optional(Type.Array(ArtifactSchema, { minItems: 1 })),
  },
  { additionalProperties: false }
);

export type DeploymentTarget = Static<typeof DeploymentTargetSchema>;
export type DeploymentTargetInput = Static<typeof InputSchema>;
export type DeploymentTargetStep = Static<typeof StepSchema>;
export type DeploymentTargetVerify = Static<typeof VerifySchema>;
export type DeploymentTargetArtifact = Static<typeof ArtifactSchema>;

const check = ajv.compile(DeploymentTargetSchema);

/**
 * Structural validation only. Cross-field rules a JSON Schema cannot express — a `when` that
 * names an input nobody declared, a duplicate id — are enforced by {@link deploymentTargetIssues}.
 *
 * @throws TulipFarmValidationError naming the first offending field.
 */
export function validateDeploymentTarget(data: unknown): DeploymentTarget {
  if (!check(data)) {
    const failure = check.errors?.[0];
    throw new TulipFarmValidationError(
      "deployment",
      failure?.instancePath ?? "",
      failure?.message ?? "invalid deployment target"
    );
  }
  return data as DeploymentTarget;
}

/** Every option value a given input can take. */
function optionValues(input: DeploymentTargetInput): Set<string> {
  return new Set(input.options.map((option) => option.value));
}

/**
 * Rules the schema cannot state. Returns one message per violation so a contributor fixes every
 * problem in one pass. The load-bearing rule is that a `when` may reference only a declared input
 * and one of that input's declared option values — the constraint that keeps the conditional a
 * pointer into the input set rather than a free expression.
 */
export function deploymentTargetIssues(target: DeploymentTarget): string[] {
  const issues: string[] = [];

  const inputsById = new Map<string, DeploymentTargetInput>();
  for (const input of target.inputs ?? []) {
    if (inputsById.has(input.id)) issues.push(`inputs: ${input.id} is declared more than once`);
    inputsById.set(input.id, input);
  }

  const checkWhen = (owner: string, when: Record<string, string> | undefined) => {
    for (const [inputId, value] of Object.entries(when ?? {})) {
      const input = inputsById.get(inputId);
      if (!input) {
        issues.push(`${owner}: when references "${inputId}", which is not a declared input`);
        continue;
      }
      if (!optionValues(input).has(value)) {
        issues.push(`${owner}: when sets ${inputId}="${value}", not one of its declared options`);
      }
    }
  };

  for (const input of target.inputs ?? []) checkWhen(`inputs.${input.id}`, input.when);

  const stepIds = new Set<string>();
  for (const step of target.steps) {
    if (stepIds.has(step.id)) issues.push(`steps: ${step.id} is declared more than once`);
    stepIds.add(step.id);
    checkWhen(`steps.${step.id}`, step.when);
  }

  const artifactIds = new Set<string>();
  for (const artifact of target.artifacts ?? []) {
    if (artifactIds.has(artifact.id)) {
      issues.push(`artifacts: ${artifact.id} is declared more than once`);
    }
    artifactIds.add(artifact.id);
  }

  return issues;
}

/**
 * The one way to turn a `targets/<slug>/manifest.yml` into a target. Every renderer goes through
 * here, so a manifest that parses but breaks a cross-field rule can never reach one.
 *
 * @throws TulipFarmValidationError on unparseable YAML, a structural failure, or any cross-field
 * violation. Cross-field violations are reported together, not one per run.
 */
export function parseDeploymentTarget(source: string): DeploymentTarget {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (cause) {
    throw new TulipFarmValidationError(
      "deployment",
      "",
      `cannot parse deployment target YAML: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  const target = validateDeploymentTarget(document);
  const issues = deploymentTargetIssues(target);
  if (issues.length > 0) {
    throw new TulipFarmValidationError("deployment", "", issues.join("; "));
  }
  return target;
}
