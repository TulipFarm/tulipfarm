import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDeploymentContract } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { type DeploymentRenderInput, renderDeploymentSurfaces } from "./render";

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();
const CONTENT = join(ROOT, "apps/docs/content/docs");

/** Read the manifest directory exactly as the generator does, so a re-render is a fair diff. */
function collectInput(): DeploymentRenderInput {
  const targetsDir = join(ROOT, "deploy/targets");
  const targets = readdirSync(targetsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((slug) => ({
      slug,
      source: readFileSync(join(targetsDir, slug, "manifest.yml"), "utf8"),
    }));
  return { contract: readFileSync(join(ROOT, "deploy/contract.yml"), "utf8"), targets };
}

describe("renderDeploymentSurfaces", () => {
  const input = collectInput();
  const result = renderDeploymentSurfaces(input);

  it("returns every surface from one call", () => {
    expect(result.pages.length).toBeGreaterThan(0);
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt.length).toBeGreaterThan(0);
    // One page per target, plus the single contract-rendered environment reference.
    expect(result.pages.length).toBe(result.wizard.targets.length + 1);
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it("is a pure function — the same input renders identically every time", () => {
    const again = renderDeploymentSurfaces(collectInput());
    expect(again).toEqual(result);
  });

  it("references published artifacts rather than generating them", () => {
    const compose = result.artifacts.find(
      (artifact) => "references" in artifact && artifact.references === "docker-compose.yml"
    );
    const env = result.artifacts.find(
      (artifact) => "references" in artifact && artifact.references === "env.example"
    );
    expect(
      compose,
      "the compose target must reference the published docker-compose.yml"
    ).toBeTruthy();
    expect(env, "and the published example env file").toBeTruthy();
  });

  it("emits generated artifacts with their rendered bytes, grounded in the contract", () => {
    const generated = result.artifacts.filter((artifact) => "content" in artifact);
    expect(
      generated.length,
      "the Kubernetes target must emit a generated values file"
    ).toBeGreaterThan(0);
    for (const artifact of generated) {
      if (!("content" in artifact)) continue;
      expect(artifact.content.length).toBeGreaterThan(0);
      expect(artifact.content).toContain("Generated from deploy/contract.yml");
      // Every workload the contract names appears, so the values cannot omit a service.
      expect(artifact.content).toContain("integration-worker:");
      // A Secret is named for wiring, never given a value.
      expect(artifact.content).toContain("ENCRYPTION_KEY");
    }
  });

  it("emits one Container Apps document per service, and no Secret value", () => {
    const definition = result.artifacts.find(
      (artifact) => "content" in artifact && artifact.filename === "containerapp.yaml"
    );
    expect(definition, "the Azure target must emit a container app definition").toBeDefined();
    if (!definition || !("content" in definition)) return;

    const contract = parseDeploymentContract(input.contract);
    for (const service of contract.services) {
      expect(definition.content).toContain(`name: tulipfarm-${service.name}`);
      if (service.port !== undefined) {
        expect(definition.content).toContain(`targetPort: ${service.port}`);
      }
    }
    // Only `app` is reachable from outside; the workers serve probes, so publishing them is a leak.
    expect(definition.content.match(/external: true/g)).toHaveLength(1);

    // Key material is wired by reference. A default that happens to ship in the contract must not
    // be copied in here, because this file is committed and served publicly.
    for (const variable of contract.env.filter((candidate) => candidate.secret)) {
      expect(definition.content, `${variable.name} must be referenced, never valued`).not.toContain(
        `name: ${variable.name}\n    value:`
      );
    }
  });

  it("keeps the on-disk generated artifacts current — re-render must be byte-identical", () => {
    for (const artifact of result.artifacts) {
      if (!("content" in artifact)) continue;
      const onDisk = readFileSync(
        join(ROOT, "deploy/targets", artifact.target, artifact.filename),
        "utf8"
      );
      expect(
        onDisk,
        `${artifact.target}/${artifact.filename} is stale. Run: pnpm --filter @tulipfarm/docs exec tsx scripts/generate-deploy-docs.ts`
      ).toBe(artifact.content);
    }
  });

  it("names its source in a header so a reader knows not to hand-edit the page", () => {
    for (const page of result.pages) {
      expect(page.content).toContain("not this file");
      expect(page.content).toMatch(
        /Generated from deploy\/(?:targets\/.+\/manifest\.yml|contract\.yml)/
      );
    }
  });

  it("keeps the on-disk generated pages current — re-render must be byte-identical", () => {
    for (const page of result.pages) {
      const onDisk = readFileSync(join(CONTENT, page.path), "utf8");
      expect(
        onDisk,
        `${page.path} is stale. Run: pnpm --filter @tulipfarm/docs exec tsx scripts/generate-deploy-docs.ts`
      ).toBe(page.content);
    }
  });
});

describe("environment variable reference", () => {
  const input = collectInput();
  const page = renderDeploymentSurfaces(input).pages.find(
    (candidate) => candidate.path === "reference/environment-variables.mdx"
  );
  const contract = parseDeploymentContract(input.contract);

  it("is generated from the contract, not hand-maintained", () => {
    expect(page, "the environment reference must be one of the rendered pages").toBeTruthy();
    expect(page?.content).toContain("Generated from deploy/contract.yml");
  });

  it("keeps the three zones and the explanation of what each means", () => {
    const framing: Array<[string, string]> = [
      ["Set these", "Normal configuration"],
      ["Installer sets these", "broken or non-standard install"],
      ["Never set these", "Internal plumbing"],
    ];
    for (const [label, meaning] of framing) {
      expect(page?.content).toContain(label);
      expect(page?.content).toContain(meaning);
    }
  });

  it("renders no variable without its consequence — every row's last cell is filled", () => {
    const lines = page?.content.split("\n") ?? [];
    const missing: string[] = [];
    for (const variable of contract.env) {
      const row = lines.find((line) => line.startsWith(`| \`${variable.name}\``));
      if (!row) {
        missing.push(`${variable.name}: no row`);
        continue;
      }
      const cells = row.split("|").map((cell) => cell.trim());
      // | Variable | Zone | Required | Default | What it does | If set wrong | → consequence is cell 6.
      if (!cells[6]) missing.push(`${variable.name}: empty consequence cell`);
    }
    expect(missing, "the contract requires a consequence, and the row must carry it").toEqual([]);
  });

  it("marks every Secret as one and shows a generate recipe, never a value", () => {
    for (const variable of contract.env.filter((candidate) => candidate.secret)) {
      expect(page?.content, `${variable.name} is a Secret and must be flagged`).toContain(
        `\`${variable.name}\` (secret)`
      );
    }
    const generated = contract.env.find((candidate) => candidate.generate);
    expect(page?.content).toContain(`Generate: \`${generated?.generate}\``);
  });
});

describe("single-file deployment prompt (/deploy.txt)", () => {
  const input = collectInput();
  const result = renderDeploymentSurfaces(input);
  const contract = parseDeploymentContract(input.contract);

  it("opens by naming the verified targets and warning every other platform is unverified", () => {
    const supported = result.wizard.targets
      .filter((target) => target.tier === "supported")
      .map((target) => target.title);
    expect(supported.length).toBeGreaterThan(0);
    for (const title of supported) {
      expect(result.prompt).toContain(`Verified targets, booted end to end in TulipFarm's CI: `);
      expect(result.prompt).toContain(title);
    }
    expect(result.prompt).toContain("UNVERIFIED");
  });

  it("tells the reader to run each verification and stop on the first failure", () => {
    expect(result.prompt).toContain("run that step's `Verify:` line");
    expect(result.prompt).toContain("STOP at the first verification that fails");
  });

  it("carries the full environment surface — every contract variable, none dropped", () => {
    for (const variable of contract.env) {
      expect(result.prompt, `${variable.name} missing from the prompt`).toContain(
        `  ${variable.name}`
      );
    }
    expect(result.prompt).toContain(`full surface: ${contract.env.length} variables`);
  });

  it("prints every when-branch labelled with its condition, so none is hidden", () => {
    let branchesChecked = 0;
    for (const target of result.wizard.targets) {
      for (const step of target.steps) {
        for (const [inputId, value] of Object.entries(step.when ?? {})) {
          expect(
            result.prompt,
            `branch ${inputId}=${value} of step ${step.id} is not labelled in the prompt`
          ).toContain(`Branch (${inputId} = ${value}`);
          branchesChecked += 1;
        }
      }
    }
    // A guard against the assertion silently passing on a manifest that has no conditional steps.
    expect(branchesChecked).toBeGreaterThan(0);
  });

  it("marks every Secret and shows its generate recipe, never a fabricated value", () => {
    const secrets = contract.env.filter((variable) => variable.secret);
    // Non-vacuous: the contract must actually carry Secrets for this assertion to mean anything.
    expect(secrets.length).toBeGreaterThan(1);
    for (const secret of secrets) {
      expect(result.prompt, `${secret.name} must be flagged as a Secret`).toContain(
        `${secret.name} (secret)`
      );
    }
    const generated = secrets.filter((variable) => variable.generate);
    expect(generated.length).toBeGreaterThan(0);
    for (const secret of generated) {
      expect(result.prompt).toContain(`generate: ${secret.generate}`);
    }
  });

  it("renders the documented weak POSTGRES_PASSWORD default faithfully — it is data, not a leak", () => {
    const postgres = contract.env.find((variable) => variable.name === "POSTGRES_PASSWORD");
    expect(postgres?.secret).toBe(true);
    expect(postgres?.default).toBeDefined();
    expect(result.prompt).toContain("POSTGRES_PASSWORD (secret)");
    expect(result.prompt).toContain(`default: ${postgres?.default}`);
  });

  it("suppresses a Secret's value even when one is present, preferring the recipe", () => {
    // A synthetic Secret carrying BOTH a generate recipe and a value: the value must never appear,
    // which keeps the leak guarantee real rather than an artefact of the contract having no values.
    const injected = `${input.contract}
  - name: TEST_SECRET_LEAK
    group: Sessions, Secrets, and limits
    zone: set-these
    consumers: [app]
    secret: true
    generate: openssl rand -hex 16
    description: Synthetic Secret proving the recipe wins over any value.
    default: SENTINEL-DO-NOT-EMIT
    consequence: Never emitted; the generate recipe is shown instead of the default.
`;
    const leaked = renderDeploymentSurfaces({ contract: injected, targets: input.targets });
    expect(leaked.prompt).toContain("generate: openssl rand -hex 16");
    expect(leaked.prompt).not.toContain("SENTINEL-DO-NOT-EMIT");
  });

  it("emits plain text — no MDX components survive from a manifest body", () => {
    expect(result.prompt).not.toContain("<Callout");
    expect(result.prompt).not.toContain("</Callout>");
  });
});

describe("wizard model", () => {
  const input = collectInput();
  const result = renderDeploymentSurfaces(input);
  const contract = parseDeploymentContract(input.contract);

  it("carries a tier on every target, so the guided flow can filter by claim not by slug", () => {
    expect(result.wizard.targets.length).toBeGreaterThan(0);
    for (const target of result.wizard.targets) {
      expect(["supported", "community"]).toContain(target.tier);
    }
    // Today exactly one target is supported; the model states it as data, not the interface.
    const supported = result.wizard.targets.filter((target) => target.tier === "supported");
    expect(supported.length).toBeGreaterThan(0);
  });

  it("describes a target in plain text, because the guided flow renders no Markdown", () => {
    for (const target of result.wizard.targets) {
      // `summary` is multi-paragraph Markdown for a documentation page. Passing it here once
      // leaked raw `[link](url)`, backticks and `**bold**` into the platform chooser.
      expect(target.description, `${target.name} carries a Markdown link`).not.toMatch(/]\(/);
      expect(target.description, `${target.name} carries a backtick`).not.toContain("`");
      expect(target.description, `${target.name} carries bold syntax`).not.toContain("**");
      expect(target.description, `${target.name} spans paragraphs`).not.toContain("\n");
    }
  });

  it("lists every when-branch as a record on the step, for the interface to evaluate", () => {
    let branches = 0;
    for (const target of result.wizard.targets) {
      for (const step of target.steps) {
        for (const [inputId, value] of Object.entries(step.when ?? {})) {
          const input = target.inputs?.find((candidate) => candidate.id === inputId);
          expect(input, `${step.id} branches on undeclared input ${inputId}`).toBeDefined();
          expect(input?.options.map((option) => option.value)).toContain(value);
          branches += 1;
        }
      }
    }
    expect(branches).toBeGreaterThan(0);
  });

  it("surfaces every Secret as a placeholder with its recipe — never a value", () => {
    const secrets = contract.env.filter((variable) => variable.secret);
    expect(secrets.length).toBeGreaterThan(1);
    expect(result.wizard.secrets.map((secret) => secret.name).sort()).toEqual(
      secrets.map((variable) => variable.name).sort()
    );
    for (const secret of result.wizard.secrets) {
      // The model shape has no field that could carry a value, and none is invented at build.
      expect(Object.keys(secret).sort()).toEqual(
        Object.keys(secret)
          .filter((key) => ["name", "description", "required", "generate"].includes(key))
          .sort()
      );
    }
    const generated = secrets.filter((variable) => variable.generate);
    expect(generated.length).toBeGreaterThan(0);
    for (const variable of generated) {
      const secret = result.wizard.secrets.find((candidate) => candidate.name === variable.name);
      expect(secret?.generate).toBe(variable.generate);
    }
  });

  it("never lets a Secret's stored value reach the wizard, preferring the recipe", () => {
    const injected = `${input.contract}
  - name: TEST_WIZARD_SECRET
    group: Sessions, Secrets, and limits
    zone: set-these
    consumers: [app]
    secret: true
    generate: openssl rand -hex 16
    description: Synthetic Secret proving the wizard carries no value.
    default: SENTINEL-DO-NOT-EMIT
    consequence: Never emitted; the recipe is shown instead of the default.
`;
    const leaked = renderDeploymentSurfaces({ contract: injected, targets: input.targets });
    const secret = leaked.wizard.secrets.find(
      (candidate) => candidate.name === "TEST_WIZARD_SECRET"
    );
    expect(secret?.generate).toBe("openssl rand -hex 16");
    expect(JSON.stringify(leaked.wizard)).not.toContain("SENTINEL-DO-NOT-EMIT");
  });
});
