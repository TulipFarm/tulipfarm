import type {
  DeploymentContract,
  DeploymentContractEnvVar,
  DeploymentTarget,
  DeploymentTargetStep,
  DeploymentTargetVerify,
} from "@tulipfarm/schema";
import {
  ENV_CONSUMER_VALUES,
  ENV_ZONE_VALUES,
  TARGET_TIER_VALUES,
  VERIFY_KIND_VALUES,
} from "@tulipfarm/schema";

/**
 * The single-file deployment guide served at `{{SITE_URL}}/deploy.txt`. It is written for one
 * reader: an LLM with a shell, working top to bottom on a platform that may not be in our
 * CI-tested set. The output keeps `{{SITE_URL}}` placeholders so the pure renderer never carries
 * the domain; the thin generator resolves them before publishing.
 *
 * Two properties are load-bearing and asserted in tests:
 *  - **No hidden branch.** A wizard reader sees only the branch a `when:` selected; a linear file
 *    must print every branch labelled with its condition, or a model reading straight through
 *    silently follows the wrong one.
 *  - **No Secret value.** A `secret: true` variable never renders a fabricated value. Where a
 *    `generate` recipe exists it renders the recipe, which is safe; a documented `default` (the
 *    shipped weak `POSTGRES_PASSWORD`) renders faithfully, because it is contract data, not a leak.
 */

const SELF_HOSTING_BASE = "{{SITE_URL}}/docs/self-hosting";

const ZONE_KEY: ReadonlyArray<[DeploymentContractEnvVar["zone"], string]> = [
  ["set-these", "normal configuration; change it to suit the deployment"],
  ["installer-sets", "overridable, but a wrong value gives a broken or non-standard install"],
  ["never-set", "internal plumbing; setting it by hand breaks things"],
];

function requiredText(variable: DeploymentContractEnvVar): string {
  if (variable.required === true) return "yes";
  if (typeof variable.required === "string") return variable.required;
  return "no";
}

/**
 * The value line for a variable. A Secret with a `generate` recipe always shows the recipe and
 * never a value, even if a `default` is also present — that ordering is what the leak test proves.
 * A Secret with only a `default` (the documented weak `POSTGRES_PASSWORD`) shows it faithfully.
 */
function valueLine(variable: DeploymentContractEnvVar): string {
  if (variable.secret && variable.generate) return `generate: ${variable.generate}`;
  if (variable.default !== undefined) return `default: ${variable.default}`;
  if (variable.generate) return `generate: ${variable.generate}`;
  return "default: none";
}

function envEntry(variable: DeploymentContractEnvVar): string {
  const secret = variable.secret ? " (secret)" : "";
  return [
    `  ${variable.name}${secret}`,
    `    zone: ${variable.zone} | required: ${requiredText(variable)} | consumers: ${variable.consumers.join(", ")}`,
    `    does: ${variable.description}`,
    `    ${valueLine(variable)}`,
    `    if set wrong: ${variable.consequence}`,
  ].join("\n");
}

/** Group labels in contract declaration order, so the surface follows the contract's own concerns. */
function orderedGroups(contract: DeploymentContract): string[] {
  const seen: string[] = [];
  for (const variable of contract.env) {
    const group = variable.group ?? "Other";
    if (!seen.includes(group)) seen.push(group);
  }
  return seen;
}

function renderEnvSurface(contract: DeploymentContract): string {
  const lines: string[] = [
    `ENVIRONMENT VARIABLES (full surface: ${contract.env.length} variables)`,
    "-".repeat(60),
    "Zone tells you whether you may change a variable:",
    ...ZONE_KEY.map(([zone, meaning]) => `  ${zone.padEnd(16)}${meaning}`),
    "",
    "Every variable is listed, including ones no verified target uses. That is exactly what",
    "lets this guide work on a platform we have never booted.",
    "",
    "A variable marked (secret) holds key material: never invent, guess, or hardcode its value.",
    "Where a `generate:` recipe is shown, run it on the deployment host and keep the output out of",
    "this file, your reply, and version control.",
    "",
    `The "consumers" of a variable are the processes that read it: ${ENV_CONSUMER_VALUES.join(", ")}.`,
    "compose and installer never reach the application, so setting one and expecting the app to",
    "honour it is already a mistake.",
  ];
  for (const group of orderedGroups(contract)) {
    lines.push("", `[Group: ${group}]`);
    for (const variable of contract.env.filter((v) => (v.group ?? "Other") === group)) {
      lines.push(envEntry(variable));
    }
  }
  return lines.join("\n");
}

function renderContract(contract: DeploymentContract): string {
  const services = contract.services.map((service) => {
    const port = service.port ? `      port ${service.port}` : "      no published port";
    const health = service.health
      ? `; health: GET ${service.health.path} expects ${service.health.expect}`
      : "";
    return `  - ${service.name}: ${service.role}\n${port}${health}`;
  });
  const dependencies = contract.dependencies.map((dependency) => {
    const drivers = dependency.drivers ? ` (drivers: ${dependency.drivers.join(", ")})` : "";
    const required = dependency.required ? "required" : "optional";
    return `  - ${dependency.id} [${required}]${drivers}: ${dependency.detail}`;
  });
  const state = contract.state.map(
    (entry) => `  - ${entry.path}: holds ${entry.holds}\n      if lost: ${entry.consequence}`
  );
  return [
    "RUNTIME CONTRACT (true on every platform)",
    "-".repeat(60),
    "Services:",
    ...services,
    "",
    "Dependencies:",
    ...dependencies,
    "",
    "Durable state: every path must survive restart and upgrade:",
    ...state,
  ].join("\n");
}

/** The verification line, phrased as a check the reader runs — plain text, never MDX or a table. */
function promptVerify(verify: DeploymentTargetVerify): string {
  switch (verify.kind) {
    case "http": {
      const within = verify.timeout ? ` within ${verify.timeout}` : "";
      return `Verify (http): GET ${verify.url} returns ${verify.expect}${within}.`;
    }
    case "file":
      return `Verify (file): \`${verify.path}\` exists in the working directory.`;
    case "command": {
      const expectation = verify.expect ? `, expect ${verify.expect}` : "";
      return `Verify (command): \`${verify.command}\` exits successfully${expectation}.`;
    }
    case "env":
      return `Verify (env): \`${verify.name}\` is set in the environment.`;
    case "manual":
      return `Check (manual): ${verify.look_for}`;
  }
}

/**
 * The condition that selects a step, named so a linear reader can tell which branch is theirs.
 * Renders both the raw `input=value` pair (stable, machine-matchable) and the human option label.
 */
function branchLabels(target: DeploymentTarget, step: DeploymentTargetStep): string[] {
  return Object.entries(step.when ?? {}).map(([inputId, value]) => {
    const input = target.inputs?.find((candidate) => candidate.id === inputId);
    const option = input?.options.find((candidate) => candidate.value === value);
    const question = input ? `, ${input.question}` : "";
    const label = option ? ` → "${option.label}"` : "";
    return `Branch (${inputId} = ${value}${label})${question}`;
  });
}

/** MDX cannot survive as plain text: drop Callout tags to a marker, make doc links absolute. */
function sanitizeBody(body: string): string {
  return body
    .trimEnd()
    .replace(/<Callout[^>]*>/g, "NOTE:")
    .replace(/<\/Callout>/g, "")
    .replace(/\]\(\/docs\//g, "]({{SITE_URL}}/docs/");
}

function renderOnFail(onFail: string): string {
  const [page, anchor] = onFail.split("#", 2);
  return `On fail: ${SELF_HOSTING_BASE}/${page}${anchor ? `#${anchor}` : ""}`;
}

function renderStep(target: DeploymentTarget, step: DeploymentTargetStep, index: number): string {
  const header = [
    `Step ${index}: ${step.title}`,
    ...branchLabels(target, step).map((label) => `  ${label}`),
  ];
  const action = [step.run ? `  run: ${step.run}` : "", `  ${promptVerify(step.verify)}`];
  if (step.on_fail) action.push(`  ${renderOnFail(step.on_fail)}`);
  const groups = [header.join("\n")];
  if (step.body) groups.push(sanitizeBody(step.body));
  groups.push(action.filter(Boolean).join("\n"));
  return groups.join("\n\n");
}

function renderTarget(target: DeploymentTarget): string {
  const tier =
    target.tier === "supported" ? "supported: verified in CI" : "community: not CI-verified";
  const header = `Target: ${target.title}  [${tier}]\n${"=".repeat(60)}`;
  const steps = target.steps.map((step, index) => renderStep(target, step, index + 1));
  return [header, sanitizeBody(target.summary), ...steps].join("\n\n");
}

/** The verified target titles, derived from `tier: supported` so a new supported target self-lists. */
function verifiedTargets(targets: DeploymentTarget[]): string {
  const names = targets
    .filter((target) => target.tier === "supported")
    .map((target) => target.title);
  return names.length > 0 ? names.join(", ") : "none";
}

export function renderPrompt(contract: DeploymentContract, targets: DeploymentTarget[]): string {
  const ordered = TARGET_TIER_VALUES.flatMap((tier) =>
    targets.filter((target) => target.tier === tier)
  );
  const zones = ENV_ZONE_VALUES.join(", ");
  const sections: string[] = [
    `TulipFarm deployment guide\n${"=".repeat(60)}`,
    [
      "You are an LLM with shell access. A human asked you to deploy TulipFarm and pointed you at",
      "this file. Work top to bottom: it is the complete configuration surface plus a verification",
      "for every action.",
    ].join("\n"),
    [
      "TRUST BOUNDARY: READ FIRST",
      "-".repeat(60),
      `Verified targets, booted end to end in TulipFarm's CI: ${verifiedTargets(targets)}.`,
      "Every other platform is UNVERIFIED. On an unverified platform you are adapting the contract",
      "below to a path nobody has tested. Use these facts, but translate them yourself and never",
      "assume a step worked.",
    ].join("\n"),
    [
      "HOW TO USE THIS FILE",
      "-".repeat(60),
      "1. After EVERY action, run that step's `Verify:` line and confirm it passes before the next",
      "   step. A `Check:` line has no automated test. Inspect for the described signal yourself.",
      "2. STOP at the first verification that fails. Do not continue and do not report success; fix",
      "   the failing step, or hand back to the human, before proceeding.",
      "3. Steps under a `Branch (input = value)` label are alternatives: exactly one applies. Pick",
      "   the one matching the human's answer to that input's question. Every branch is printed",
      "   here. Never follow one whose condition you did not choose.",
      "4. Never invent, guess, or hardcode a value marked `(secret)`. Where a `generate:` recipe is",
      "   shown, run it on the deployment host and keep the output out of this file and any reply.",
      "",
      `Verification kinds you will meet: ${VERIFY_KIND_VALUES.join(", ")}.`,
      `Zones you will meet in the variable list: ${zones}.`,
    ].join("\n"),
    renderContract(contract),
    renderEnvSurface(contract),
    `TARGETS\n${"=".repeat(60)}`,
    ...ordered.map(renderTarget),
  ];
  return `${sections.join("\n\n")}\n`;
}
