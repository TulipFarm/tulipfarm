import { type Static, Type } from "@sinclair/typebox";
import { parse as parseYaml } from "yaml";
import { ajv } from "./ajv";
import { TulipFarmValidationError } from "./error";

/**
 * Zones match the three the environment variable reference already teaches. A fourth zone would
 * split the answer to the only question a reader arrives with: am I allowed to change this.
 */
const ENV_ZONES = ["set-these", "installer-sets", "never-set"] as const;

/**
 * Which process actually reads the value. `compose` and `installer` are load-bearing: those
 * variables never reach the application, so a reader who sets one expecting the app to honour it
 * is already wrong.
 */
const ENV_CONSUMERS = [
  "app",
  "web",
  "worker",
  "integration-worker",
  "compose",
  "installer",
] as const;

export const ENV_ZONE_VALUES = ENV_ZONES;
export const ENV_CONSUMER_VALUES = ENV_CONSUMERS;

const NonEmpty = Type.String({ minLength: 1 });

const HealthCheckSchema = Type.Object(
  {
    path: NonEmpty,
    expect: Type.Integer({ minimum: 100, maximum: 599 }),
  },
  { additionalProperties: false }
);

const ServiceSchema = Type.Object(
  {
    name: NonEmpty,
    role: NonEmpty,
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    health: Type.Optional(HealthCheckSchema),
  },
  { additionalProperties: false }
);

const DependencySchema = Type.Object(
  {
    id: NonEmpty,
    required: Type.Boolean(),
    detail: NonEmpty,
    drivers: Type.Optional(Type.Array(NonEmpty, { minItems: 1 })),
  },
  { additionalProperties: false }
);

/**
 * `consequence` is required rather than optional because a durable path documented without the
 * cost of losing it reads as advisory, and the encryption key lives on one of these paths.
 */
const DurableStateSchema = Type.Object(
  {
    path: NonEmpty,
    holds: NonEmpty,
    durability: NonEmpty,
    consequence: NonEmpty,
  },
  { additionalProperties: false }
);

const EnvVarSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }),
    zone: Type.Unsafe<(typeof ENV_ZONES)[number]>({ type: "string", enum: [...ENV_ZONES] }),
    /**
     * The concern this variable belongs to — required boot, networking, workers, and so on. Purely
     * a rendering aid: the reference page groups 100+ variables under it so the page stays
     * navigable, and grouping by concern reads better than grouping by the three zones alone.
     */
    group: Type.Optional(NonEmpty),
    consumers: Type.Array(
      Type.Unsafe<(typeof ENV_CONSUMERS)[number]>({ type: "string", enum: [...ENV_CONSUMERS] }),
      { minItems: 1 }
    ),
    description: NonEmpty,
    consequence: NonEmpty,
    required: Type.Optional(Type.Union([Type.Boolean(), NonEmpty])),
    secret: Type.Optional(Type.Boolean()),
    default: Type.Optional(Type.String()),
    generate: Type.Optional(NonEmpty),
  },
  { additionalProperties: false }
);

export const DeploymentContractSchema = Type.Object(
  {
    version: Type.Literal(1),
    services: Type.Array(ServiceSchema, { minItems: 1 }),
    dependencies: Type.Array(DependencySchema, { minItems: 1 }),
    state: Type.Array(DurableStateSchema, { minItems: 1 }),
    env: Type.Array(EnvVarSchema, { minItems: 1 }),
  },
  { additionalProperties: false }
);

export type DeploymentContract = Static<typeof DeploymentContractSchema>;
export type DeploymentContractEnvVar = Static<typeof EnvVarSchema>;
export type DeploymentContractService = Static<typeof ServiceSchema>;

const check = ajv.compile(DeploymentContractSchema);

/**
 * Structural validation only. Cross-field rules that a JSON Schema cannot express — a Secret in
 * the wrong zone, a duplicate name, a `generate` on a value nobody generates — are enforced by
 * {@link deploymentContractIssues}, because a caller that skips them still gets a usable object.
 *
 * @throws TulipFarmValidationError naming the first offending field.
 */
export function validateDeploymentContract(data: unknown): DeploymentContract {
  if (!check(data)) {
    const failure = check.errors?.[0];
    throw new TulipFarmValidationError(
      "deployment",
      failure?.instancePath ?? "",
      failure?.message ?? "invalid deployment contract"
    );
  }
  return data as DeploymentContract;
}

/**
 * Rules the schema cannot state. Returns one message per violation so a contributor fixes every
 * problem in one pass rather than one per run.
 */
export function deploymentContractIssues(contract: DeploymentContract): string[] {
  const issues: string[] = [];

  const seen = new Set<string>();
  for (const variable of contract.env) {
    if (seen.has(variable.name)) issues.push(`env: ${variable.name} is declared more than once`);
    seen.add(variable.name);

    if (variable.secret && variable.zone === "never-set") {
      issues.push(`env: ${variable.name} holds a Secret, so "never set this" is incoherent`);
    }
    if (variable.generate && !variable.secret) {
      issues.push(`env: ${variable.name} declares generate but is not marked secret`);
    }
    if (variable.zone === "never-set" && variable.required) {
      issues.push(`env: ${variable.name} is never-set, so it cannot also be required`);
    }
  }

  const serviceNames = new Set<string>();
  for (const service of contract.services) {
    if (serviceNames.has(service.name)) issues.push(`services: ${service.name} is declared twice`);
    serviceNames.add(service.name);
  }

  const dependencyIds = new Set<string>();
  for (const dependency of contract.dependencies) {
    if (dependencyIds.has(dependency.id)) {
      issues.push(`dependencies: ${dependency.id} is declared twice`);
    }
    dependencyIds.add(dependency.id);
  }

  return issues;
}

/**
 * The one way to turn `deploy/contract.yml` into a contract. Every renderer goes through here, so
 * a contract that parses but breaks a cross-field rule can never reach one — the rules are worth
 * nothing if a caller can skip them by parsing the YAML itself.
 *
 * @throws TulipFarmValidationError on unparseable YAML, a structural failure, or any cross-field
 * violation. Cross-field violations are reported together, not one per run.
 */
export function parseDeploymentContract(source: string): DeploymentContract {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (cause) {
    throw new TulipFarmValidationError(
      "deployment",
      "",
      `cannot parse deployment contract YAML: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  const contract = validateDeploymentContract(document);
  const issues = deploymentContractIssues(contract);
  if (issues.length > 0) {
    throw new TulipFarmValidationError("deployment", "", issues.join("; "));
  }
  return contract;
}
