import type { DeploymentContract, DeploymentContractEnvVar } from "@tulipfarm/schema";

/**
 * The generated Azure Container Apps definition, built from `contract.yml` alone.
 *
 * Container Apps takes one YAML per app, so this emits three documents — one per service — rather
 * than the single file Kubernetes values use. Every port, probe path and environment key is read
 * from the contract, so the definition cannot drift from the image it configures.
 *
 * It never emits a Secret value. Key material is emitted as a `secretRef` pointing at a Container
 * Apps secret the operator creates; the recipe to mint one lives in the environment reference.
 */

const IMAGE = "ghcr.io/tulipfarm/tulipfarm:latest";

/** JSON encodes to a valid YAML double-quoted scalar, so a value with a colon or comma stays safe. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

const APP_FACING = new Set(["app", "web", "worker", "integration-worker"]);

function isConfigurable(variable: DeploymentContractEnvVar): boolean {
  if (variable.zone === "never-set") return false;
  return variable.consumers.some((consumer) => APP_FACING.has(consumer));
}

/** Container Apps secret names are lowercase and dash-separated, unlike the variable they feed. */
function secretName(variable: string): string {
  return variable.toLowerCase().replaceAll("_", "-");
}

/** The contract's consumer vocabulary, so a service name cannot be compared against a typo. */
type Consumer = DeploymentContractEnvVar["consumers"][number];

/** `services[].name` is a free string, so widen the comparison rather than assert the union. */
function consumedBy(variable: DeploymentContractEnvVar, service: string): boolean {
  return variable.consumers.some((consumer: Consumer) => consumer === service);
}

function envLines(contract: DeploymentContract, service: string, indent: string): string[] {
  const forService = contract.env.filter(
    (variable) => isConfigurable(variable) && consumedBy(variable, service)
  );
  const lines = [`${indent}env:`];
  for (const variable of forService) {
    lines.push(`${indent}  - name: ${variable.name}`);
    if (variable.secret) lines.push(`${indent}    secretRef: ${secretName(variable.name)}`);
    else lines.push(`${indent}    value: ""`);
  }
  return lines;
}

function secretsLines(contract: DeploymentContract, service: string, indent: string): string[] {
  const secrets = contract.env.filter(
    (variable) => variable.secret && isConfigurable(variable) && consumedBy(variable, service)
  );
  if (secrets.length === 0) return [];
  const lines = [
    `${indent}# Create each with: az containerapp secret set --secrets <name>=<value>`,
    `${indent}# Never write a value into this file; it is committed and served publicly.`,
    `${indent}secrets:`,
  ];
  for (const variable of secrets) lines.push(`${indent}  - name: ${secretName(variable.name)}`);
  return lines;
}

/**
 * One Container Apps definition per service. Only `app` takes external ingress — the workers expose
 * probe-only HTTP servers, so their ingress stays internal.
 */
function appDocument(
  contract: DeploymentContract,
  service: DeploymentContract["services"][number]
) {
  const isApp = service.name === "app";
  const lines = [
    `# ---- ${service.name}: ${service.role} ----`,
    `name: tulipfarm-${service.name}`,
    "type: Microsoft.App/containerApps",
    "properties:",
    "  configuration:",
  ];

  if (service.port !== undefined) {
    lines.push("    ingress:");
    lines.push(`      external: ${isApp}`);
    lines.push(`      targetPort: ${service.port}`);
    lines.push("      transport: auto");
    if (isApp) {
      lines.push(
        "      # Chat streams over SSE. allowInsecure stays false; TLS ends at the ingress."
      );
      lines.push("      allowInsecure: false");
    }
  }
  lines.push(...secretsLines(contract, service.name, "    "));

  lines.push("  template:");
  lines.push("    containers:");
  lines.push(`      - name: ${service.name}`);
  lines.push(`        image: ${IMAGE}`);
  if (service.health) {
    // The contract states one health endpoint per service; Container Apps splits startup from
    // liveness and readiness. We emit the contract's path for each and let the operator widen the
    // startup budget, which matters because `app` migrates before it listens.
    lines.push("        probes:");
    for (const probeType of ["Startup", "Liveness", "Readiness"]) {
      lines.push(`          - type: ${probeType}`);
      lines.push("            httpGet:");
      lines.push(`              path: ${yamlString(service.health.path)}`);
      if (service.port !== undefined) lines.push(`              port: ${service.port}`);
      if (probeType === "Startup") {
        lines.push("            failureThreshold: 60");
        lines.push("            periodSeconds: 10");
      }
    }
  }
  lines.push(...envLines(contract, service.name, "        "));
  lines.push("    scale:");
  lines.push("      # TulipFarm runs exactly one replica of each workload. Never raise these.");
  lines.push("      minReplicas: 1");
  lines.push("      maxReplicas: 1");

  return lines.join("\n");
}

/**
 * Render the Container Apps definition for the Azure target from the contract. Deterministic and
 * pure — the same contract renders the same bytes, which is what the staleness test relies on.
 */
export function renderContainerApp(contract: DeploymentContract): string {
  const header = [
    "# Generated from deploy/contract.yml by @tulipfarm/deploy-render. Edit the contract, not this",
    "# file. Three Container Apps definitions, one per workload, with every port, probe path and",
    "# environment key grounded in what the runtime actually reads.",
    "#",
    "# Azure Container Apps has no durable persistent volume, so the filesystem blob driver is not",
    "# an option here: set the Azure Blob driver and point DATABASE_URL at managed PostgreSQL.",
  ].join("\n");

  const documents = contract.services.map((service) => appDocument(contract, service));
  return `${header}\n\n${documents.join("\n\n---\n\n")}\n`;
}
