import type { DeploymentContract, DeploymentContractEnvVar } from "@tulipfarm/schema";

/**
 * The generated Kubernetes chart values, built from `contract.yml` alone. Unlike the Compose file —
 * which is hand-maintained and referenced byte-identical — Kubernetes has no published artifact, so
 * this file is genuinely derived. Deriving it keeps it from drifting: every workload, port, health
 * path and environment key here is read straight from the contract, never restated by hand.
 *
 * It never emits a Secret value. Variables that hold key material are listed by name under
 * `secretRefs` so the operator wires a Kubernetes `Secret`; the recipe to mint one is in the
 * environment-variable reference, not here.
 */

const IMAGE_REPOSITORY = "ghcr.io/tulipfarm/tulipfarm";

/** The published image is the same one Compose and the installer boot; it is not a contract field. */
const IMAGE_BLOCK = [
  "image:",
  `  repository: ${IMAGE_REPOSITORY}`,
  "  # Pin a tag in a cluster; never track a moving tag.",
  '  tag: "latest"',
  "  pullPolicy: IfNotPresent",
].join("\n");

/** JSON encodes to a valid YAML double-quoted scalar, so a value with a colon or comma stays safe. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

const APP_FACING = new Set(["app", "web", "worker", "integration-worker"]);

/** A variable a workload process actually reads, and that an operator is allowed to set. */
function isConfigurable(variable: DeploymentContractEnvVar): boolean {
  if (variable.zone === "never-set") return false;
  return variable.consumers.some((consumer) => APP_FACING.has(consumer));
}

function orderedGroups(env: DeploymentContractEnvVar[]): string[] {
  const seen: string[] = [];
  for (const variable of env) {
    const group = variable.group ?? "Other";
    if (!seen.includes(group)) seen.push(group);
  }
  return seen;
}

/** One workload block per service, carrying the fields Kubernetes needs and the contract provides. */
function workloadsBlock(contract: DeploymentContract): string {
  const lines = [
    "# One replica each — TulipFarm does not scale horizontally, so use strategy: Recreate.",
    "workloads:",
  ];
  for (const service of contract.services) {
    lines.push(`  ${service.name}:`);
    lines.push("    replicas: 1");
    if (service.port !== undefined) lines.push(`    port: ${service.port}`);
    lines.push(`    role: ${yamlString(service.role)}`);
    if (service.health) {
      // The contract models one health endpoint per service; Kubernetes wants a startup, liveness
      // and readiness probe. We emit the path the contract states and let the chart reuse it.
      lines.push("    healthProbe:");
      lines.push(`      path: ${yamlString(service.health.path)}`);
      lines.push(`      expect: ${service.health.expect}`);
    }
  }
  return lines.join("\n");
}

function dependenciesBlock(contract: DeploymentContract): string {
  const blob = contract.dependencies.find((dependency) => dependency.id === "blob");
  const drivers = blob?.drivers ?? [];
  const lines = [
    "dependencies:",
    "  postgres:",
    "    # A cluster rarely wants a bundled database. Point DATABASE_URL at managed PostgreSQL 17",
    "    # (pgvector + citext) and supply it from a Secret; see secretRefs below.",
    "    external: true",
    "  blob:",
    `    # One of: ${drivers.join(", ")}. A cluster has no durable local disk, so filesystem suits`,
    "    # only a single-node test; use s3 or azure for anything real.",
    '    driver: "s3"',
  ];
  return lines.join("\n");
}

function stateBlock(contract: DeploymentContract): string {
  const lines = [
    "# Durable state that must survive restart and upgrade. The contract names these symbolically",
    "# (by the variable that points at them); the chart maps each to a PersistentVolumeClaim.",
    "persistence:",
  ];
  for (const entry of contract.state) {
    lines.push(`  - path: ${yamlString(entry.path)}`);
    lines.push(`    holds: ${yamlString(entry.holds)}`);
  }
  return lines.join("\n");
}

function configBlock(contract: DeploymentContract): string {
  const configurable = contract.env.filter(isConfigurable);
  const lines = [
    "# Non-secret configuration. Every key is a real environment variable; see the reference for",
    "# what each does and its default. Fill the ones your deployment needs and delete the rest.",
    "config:",
  ];
  for (const group of orderedGroups(configurable)) {
    const inGroup = configurable.filter(
      (variable) => (variable.group ?? "Other") === group && !variable.secret
    );
    if (inGroup.length === 0) continue;
    lines.push(`  # ${group}`);
    for (const variable of inGroup) lines.push(`  ${variable.name}: ""`);
  }
  return lines.join("\n");
}

function secretsBlock(contract: DeploymentContract): string {
  const secrets = contract.env.filter((variable) => variable.secret && isConfigurable(variable));
  const lines = [
    "# These variables hold key material. Create a Kubernetes Secret and reference it here by name;",
    "# never write a value into this file. The reference lists the generate recipe for each.",
    "secretRefs:",
  ];
  for (const variable of secrets) lines.push(`  - ${variable.name}`);
  return lines.join("\n");
}

/**
 * Render the `values.yaml` for the Kubernetes target from the contract. Deterministic and pure —
 * the same contract renders the same bytes, which is what the staleness test relies on.
 */
export function renderHelmValues(contract: DeploymentContract): string {
  const header = [
    "# Generated from deploy/contract.yml by @tulipfarm/deploy-render. Edit the contract, not this",
    "# file. TulipFarm ships no official chart yet: these are the machine-generated configuration",
    "# values — every key grounded in the runtime contract — to feed the chart you supply.",
  ].join("\n");

  return `${[
    header,
    IMAGE_BLOCK,
    workloadsBlock(contract),
    dependenciesBlock(contract),
    stateBlock(contract),
    configBlock(contract),
    secretsBlock(contract),
  ].join("\n\n")}\n`;
}
