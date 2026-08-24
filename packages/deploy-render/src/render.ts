import {
  type DeploymentContract,
  type DeploymentContractEnvVar,
  type DeploymentTarget,
  type DeploymentTargetStep,
  type DeploymentTargetVerify,
  parseDeploymentContract,
  parseDeploymentTarget,
} from "@tulipfarm/schema";
import { renderContainerApp } from "./containerapp";
import { renderPrompt } from "./prompt";
import { renderHelmValues } from "./values";

/** One target manifest, named by its directory slug. */
export interface TargetSource {
  slug: string;
  source: string;
}

/**
 * The manifest directory contents, as strings. The renderer parses and renders them; it never
 * reads a file or opens a socket, which is what lets the doc generator, the prompt endpoint, and
 * the wizard all drive it from one call.
 */
export interface DeploymentRenderInput {
  contract: string;
  targets: TargetSource[];
}

/** A file the caller is expected to persist, path relative to the docs content root. */
export interface RenderedFile {
  path: string;
  content: string;
}

/**
 * A Secret the wizard surfaces as a placeholder and the command that mints it on the operator's own
 * machine — never a value. It carries the generation recipe from the contract so the guided flow has
 * no reason to ask for, store, or transmit the Secret itself (decision D6).
 */
export interface WizardSecret {
  name: string;
  description: string;
  required?: boolean | string;
  generate?: string;
}

/** The wizard's serialisable model — structure only, no rendering and no secret value. */
export interface WizardModel {
  targets: Array<{
    name: string;
    title: string;
    tier: DeploymentTarget["tier"];
    /** The plain one-line `description`, never `summary` — the latter is multi-paragraph
     * Markdown meant for a documentation page, and the guided flow renders text, not Markdown. */
    description: string;
    inputs: DeploymentTarget["inputs"];
    steps: Array<{
      id: string;
      title: string;
      when?: Record<string, string>;
      /** The one command this step runs, when the manifest names one. Steps whose work is prose
       * rather than a command carry none, and the reader follows the linked page instead. */
      run?: string;
      verify: DeploymentTargetVerify;
    }>;
    artifacts: DeploymentTarget["artifacts"];
  }>;
  /** Every `secret: true` contract variable, as a placeholder plus its generation recipe. */
  secrets: WizardSecret[];
}

/**
 * An artifact the caller persists. A *referenced* artifact names a published file the caller
 * already serves; a *generated* one carries its rendered bytes, because Kubernetes has no published
 * file to point at. The caller writes the latter and leaves the former alone.
 */
export type RenderedArtifact =
  | { target: string; id: string; references: string }
  | { target: string; id: string; filename: string; content: string };

export interface DeploymentRenderResult {
  /** Generated documentation pages. */
  pages: RenderedFile[];
  /** The single-file LLM prompt served at `/deploy.txt`. */
  prompt: string;
  /** The guided flow's model. */
  wizard: WizardModel;
  /** Published artifacts a target references, and generated ones a target emits. */
  artifacts: RenderedArtifact[];
}

const SELF_HOSTING = "self-hosting";
const REFERENCE = "reference";
const CONTRACT_SOURCE = "deploy/contract.yml";

const REFERENCE_DESCRIPTION =
  "Every environment variable TulipFarm reads or ships, grouped by concern and tagged with the zone that says whether you may change it.";

const REFERENCE_INTRO =
  "TulipFarm reads configuration from the process environment. Source checkouts usually load `.env.local`; self-hosted installs write `/opt/tulipfarm/.env` for Docker Compose.";

const REFERENCE_ZONE_LEAD =
  "Most people arrive here holding one variable name and one question: **am I allowed to change this?** Every variable below names the zone that answers it.";

/** The three zones and what each means — the page's whole reason to exist, kept beside the schema. */
const ZONE_GUIDE: ReadonlyArray<{
  zone: DeploymentContractEnvVar["zone"];
  label: string;
  meaning: string;
}> = [
  {
    zone: "set-these",
    label: "Set these",
    meaning: "Normal configuration. Change them to suit your deployment.",
  },
  {
    zone: "installer-sets",
    label: "Installer sets these",
    meaning: "Overridable, but a wrong value gives you a broken or non-standard install.",
  },
  {
    zone: "never-set",
    label: "Never set these",
    meaning: "Internal plumbing. Setting them by hand breaks things.",
  },
];

const ZONE_CELL: Record<DeploymentContractEnvVar["zone"], string> = {
  "set-these": "Set these",
  "installer-sets": "Installer sets",
  "never-set": "Never set",
};

/**
 * Per-group prose the contract cannot carry: a cross-link and one operational nuance that belong to
 * a whole concern rather than any single variable. Keyed by the group label in the contract; a
 * group without an entry simply renders no note.
 */
const GROUP_NOTES: Record<string, string> = {
  "Workers and service credentials":
    "The API can mint worker credentials into `TF_DATA_DIR`. An environment value always wins; the generated file is only a fallback for container installs that share the data volume.",
  "Sessions, Secrets, and limits":
    "Model configuration can also reach an environment variable directly, through an `env://<NAME>` reference. That escape hatch is not a variable this contract can enumerate — the name is chosen when the model is configured, and it must already be set at that moment.",
  "File storage":
    "Unset, files land on disk under `TF_DATA_DIR` — correct for development, wrong for anything with more than one replica or a container that restarts. The Compose stack points these at its bundled bucket service; see [where uploaded and generated files go](/docs/self-hosting/docker-compose#where-uploaded-and-generated-files-go).",
};

const ENV_TABLE_HEAD = [
  "| Variable | Zone | Required | Default | What it does | If set wrong |",
  "| --- | --- | --- | --- | --- | --- |",
];

/** MDX reads `<`, `>`, `{`, `}` as markup and `|` as a table divider; entity-encode them for a cell. */
function escapeCell(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

function requiredCell(variable: DeploymentContractEnvVar): string {
  if (variable.required === true) return "Yes";
  if (typeof variable.required === "string") return escapeCell(variable.required);
  return "No";
}

/** A default value, or the recipe for a generated Secret — never the Secret itself. */
function defaultCell(variable: DeploymentContractEnvVar): string {
  if (variable.default !== undefined) return escapeCell(variable.default);
  if (variable.generate) return `Generate: \`${variable.generate}\``;
  return "—";
}

function variableCell(variable: DeploymentContractEnvVar): string {
  return variable.secret ? `\`${variable.name}\` (secret)` : `\`${variable.name}\``;
}

function envRow(variable: DeploymentContractEnvVar): string {
  const cells = [
    variableCell(variable),
    ZONE_CELL[variable.zone],
    requiredCell(variable),
    defaultCell(variable),
    escapeCell(variable.description),
    escapeCell(variable.consequence),
  ];
  return `| ${cells.join(" | ")} |`;
}

/** Group labels in contract declaration order, so the page follows the contract's own concerns. */
function orderedGroups(contract: DeploymentContract): string[] {
  const seen: string[] = [];
  for (const variable of contract.env) {
    const group = variable.group ?? "Other";
    if (!seen.includes(group)) seen.push(group);
  }
  return seen;
}

/**
 * The environment variable reference, rendered from the contract rather than hand-maintained. The
 * three-zone framing is the page's spine; the tables under it are generated so no variable can lose
 * its consequence and no Secret's value is ever emitted.
 */
function renderEnvReference(contract: DeploymentContract): RenderedFile {
  const header = [
    `{/* Generated from ${CONTRACT_SOURCE} by @tulipfarm/deploy-render. Edit the contract, not this file. */}`,
    `{/* tf-claim kind=path-exists value="${CONTRACT_SOURCE}" */}`,
  ].join("\n");

  const zoneTable = [
    "| Zone | Meaning |",
    "| --- | --- |",
    ...ZONE_GUIDE.map((entry) => `| ${entry.label} | ${entry.meaning} |`),
  ].join("\n");

  const sections = orderedGroups(contract).map((group) => {
    const rows = contract.env
      .filter((variable) => (variable.group ?? "Other") === group)
      .map(envRow);
    const note = GROUP_NOTES[group];
    const parts = [`## ${group}`];
    if (note) parts.push(note);
    parts.push([...ENV_TABLE_HEAD, ...rows].join("\n"));
    return parts.join("\n\n");
  });

  const body = [
    ["---", "title: Environment variables", `description: ${REFERENCE_DESCRIPTION}`, "---"].join(
      "\n"
    ),
    header,
    REFERENCE_INTRO,
    REFERENCE_ZONE_LEAD,
    zoneTable,
    ...sections,
  ].join("\n\n");

  return { path: `${REFERENCE}/environment-variables.mdx`, content: `${body}\n` };
}

function manifestPath(slug: string): string {
  return `deploy/targets/${slug}/manifest.yml`;
}

function whenLabel(target: DeploymentTarget, when: Record<string, string>): string {
  const clauses = Object.entries(when).map(([inputId, value]) => {
    const input = target.inputs?.find((candidate) => candidate.id === inputId);
    const option = input?.options.find((candidate) => candidate.value === value);
    return option?.label ?? `${inputId}=${value}`;
  });
  return `Applies when you chose **${clauses.join("** and **")}**.`;
}

function renderVerify(verify: DeploymentTargetVerify): string {
  switch (verify.kind) {
    case "http": {
      const within = verify.timeout ? ` within ${verify.timeout}` : "";
      return `> **Verify.** \`${verify.url}\` answers \`${verify.expect}\`${within}.`;
    }
    case "file":
      return `> **Verify.** \`${verify.path}\` is now in the working directory.`;
    case "command": {
      const expectation = verify.expect ? ` — expect ${verify.expect}` : "";
      return `> **Verify.** \`${verify.command}\` succeeds${expectation}.`;
    }
    case "env":
      return `> **Verify.** \`${verify.name}\` is set in the environment.`;
    case "manual":
      return `> **Check.** ${verify.look_for}`;
  }
}

function renderOnFail(onFail: string): string {
  const [page, anchor] = onFail.split("#", 2);
  const href = `/docs/${SELF_HOSTING}/${page}${anchor ? `#${anchor}` : ""}`;
  return `If that check fails, see [what to do next](${href}).`;
}

function renderStep(target: DeploymentTarget, step: DeploymentTargetStep): string {
  const parts: string[] = [`## ${step.title}`];
  if (step.when) parts.push(`_${whenLabel(target, step.when)}_`);
  if (step.body) parts.push(step.body.trimEnd());
  if (step.run) parts.push(["```bash", step.run, "```"].join("\n"));
  parts.push(renderVerify(step.verify));
  if (step.on_fail) parts.push(renderOnFail(step.on_fail));
  return parts.join("\n\n");
}

function renderPage(target: DeploymentTarget, slug: string, allSlugs: string[]): RenderedFile {
  const source = manifestPath(slug);
  const header = [
    `{/* Generated from ${source} by @tulipfarm/deploy-render. Edit the manifest, not this file. */}`,
    `{/* tf-claim kind=path-exists value="${source}" */}`,
  ];
  // The target-set claims are global; they live on the primary (only) generated page today and a
  // later ticket relocates them to a supported-targets overview once a second target exists.
  if (slug === "docker-compose") {
    header.push(`{/* tf-claim kind=deploy-target-slugs value="${allSlugs.join(",")}" */}`);
    header.push(`{/* tf-claim kind=deploy-target-count value="${allSlugs.length}" */}`);
  }

  const body = [
    ["---", `title: ${target.title}`, `description: ${target.description}`, "---"].join("\n"),
    header.join("\n"),
    'import { Callout } from "fumadocs-ui/components/callout";',
    target.summary.trimEnd(),
    ...target.steps.map((step) => renderStep(target, step)),
  ].join("\n\n");

  return { path: `${SELF_HOSTING}/${slug}.mdx`, content: `${body}\n` };
}

/** Map a generated artifact's declared generator to its builder. The set matches the schema's. */
function renderGeneratedArtifact(
  from: "helm-values" | "containerapp",
  contract: DeploymentContract
): string {
  switch (from) {
    case "helm-values":
      return renderHelmValues(contract);
    case "containerapp":
      return renderContainerApp(contract);
  }
}

function buildWizard(targets: DeploymentTarget[], contract: DeploymentContract): WizardModel {
  return {
    targets: targets.map((target) => ({
      name: target.name,
      title: target.title,
      tier: target.tier,
      description: target.description,
      inputs: target.inputs,
      steps: target.steps.map((step) => ({
        id: step.id,
        title: step.title,
        ...(step.when ? { when: step.when } : {}),
        ...(step.run ? { run: step.run } : {}),
        verify: step.verify,
      })),
      artifacts: target.artifacts,
    })),
    secrets: contract.env
      .filter((variable) => variable.secret === true)
      .map((variable) => ({
        name: variable.name,
        description: variable.description,
        ...(variable.required !== undefined ? { required: variable.required } : {}),
        ...(variable.generate ? { generate: variable.generate } : {}),
      })),
  };
}

/**
 * The single rendering seam. Takes the manifest directory contents and returns every surface —
 * documentation pages, the `/deploy.txt` prompt, the wizard model, and the artifact references —
 * from one call, with no writes and no network. A thin script persists what it returns.
 */
export function renderDeploymentSurfaces(input: DeploymentRenderInput): DeploymentRenderResult {
  const contract = parseDeploymentContract(input.contract);
  const parsed = input.targets.map((target) => ({
    slug: target.slug,
    target: parseDeploymentTarget(target.source),
  }));

  const slugs = parsed.map((entry) => entry.slug);
  const pages = [
    ...parsed.map(({ slug, target }) => renderPage(target, slug, slugs)),
    renderEnvReference(contract),
  ];
  const artifacts = parsed.flatMap(({ target }) =>
    (target.artifacts ?? []).map((artifact): RenderedArtifact => {
      if ("references" in artifact) {
        return { target: target.name, id: artifact.id, references: artifact.references };
      }
      return {
        target: target.name,
        id: artifact.id,
        filename: artifact.filename,
        content: renderGeneratedArtifact(artifact.from, contract),
      };
    })
  );

  return {
    pages,
    prompt: renderPrompt(
      contract,
      parsed.map((entry) => entry.target)
    ),
    wizard: buildWizard(
      parsed.map((entry) => entry.target),
      contract
    ),
    artifacts,
  };
}
