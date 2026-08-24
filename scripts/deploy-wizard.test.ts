import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeInputs,
  applicableSteps,
  chosenLabel,
  defaultAnswers,
  guidedTargets,
  inputStageId,
  resolveSiteUrl,
  stageOrder,
  whenMatches,
} from "../apps/docs/app/deploy/model";
import { renderDeploymentSurfaces, type WizardModel } from "../packages/deploy-render/src/render";

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
const DEPLOY_DIR = join(ROOT, "apps/docs/app/deploy");

function buildModel(): WizardModel {
  const targetsDir = join(ROOT, "deploy/targets");
  const targets = readdirSync(targetsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((slug) => ({
      slug,
      source: readFileSync(join(targetsDir, slug, "manifest.yml"), "utf8"),
    }));
  return renderDeploymentSurfaces({
    contract: readFileSync(join(ROOT, "deploy/contract.yml"), "utf8"),
    targets,
  }).wizard;
}

/** The `.ts`/`.tsx` files that make up the deploy route's own module graph. */
function deployRouteSources(): string[] {
  return readdirSync(DEPLOY_DIR)
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => readFileSync(join(DEPLOY_DIR, file), "utf8"));
}

describe("deploy wizard — the guided flow's model consumption", () => {
  const model = buildModel();

  it("offers every target the model carries, and the menu is read from the model not a slug", () => {
    const guided = guidedTargets(model);
    expect([...guided.map((target) => target.name)].sort()).toEqual(
      model.targets.map((target) => target.name).sort()
    );
    expect(guided.length).toBeGreaterThan(1);

    // Prove the menu is data-driven: add a target no line of interface code has heard of, and it
    // must appear. If the menu filtered by tier or by a slug list, this would fail.
    const [first] = model.targets;
    expect(first, "the fixture needs at least one target to clone").toBeDefined();
    const extended: WizardModel = {
      ...model,
      targets: [
        ...model.targets,
        { ...first, name: "invented-platform", title: "Invented Platform", tier: "community" },
      ],
    };
    expect(guidedTargets(extended).map((target) => target.name)).toContain("invented-platform");
    expect(guidedTargets(extended).length).toBe(guided.length + 1);
  });

  it("leads with what CI boots, so the verified path is the one a reader meets first", () => {
    const tiers = guidedTargets(model).map((target) => target.tier);
    const lastSupported = tiers.lastIndexOf("supported");
    const firstCommunity = tiers.indexOf("community");
    expect(lastSupported, "the fixture needs a supported target").toBeGreaterThan(-1);
    expect(firstCommunity, "the fixture needs a community target").toBeGreaterThan(-1);
    expect(lastSupported).toBeLessThan(firstCommunity);
  });

  it("keeps the unverified targets honest, without demoting them out of the menu", () => {
    const guided = guidedTargets(model);
    for (const target of guided) {
      expect(["supported", "community"], `${target.name} carries no tier`).toContain(target.tier);
    }

    // The tier is the honesty of the page. A silent promotion of every target to `supported` —
    // or a quiet drop of the community ones back out of the menu — must not pass unnoticed.
    expect(guided.some((target) => target.tier === "supported")).toBe(true);
    expect(guided.some((target) => target.tier === "community")).toBe(true);

    // The badges are gone, so the notice above the steps is the only thing left carrying that
    // promise. If it stops being gated on the tier, the page silently claims every platform is
    // verified. `model.ts` also compares tiers, to order the menu, so match the render site.
    const gated = deployRouteSources().some(
      (source) => /tier === "supported" \? null :/.test(source) && /<UnverifiedNotice/.test(source)
    );
    expect(gated, "no source gates the unverified notice on the target's tier").toBe(true);
  });

  it("evaluates step `when` from the rendered model, not a re-derived conditional", () => {
    const dockerCompose = guidedTargets(model).find((target) => target.name === "docker-compose");
    expect(dockerCompose, "docker-compose is the supported target").toBeDefined();
    if (!dockerCompose) return;

    const bundled = applicableSteps(dockerCompose, { database: "bundled" }).map((step) => step.id);
    const managed = applicableSteps(dockerCompose, { database: "managed" }).map((step) => step.id);

    // The manifest asserts these branches; the interface only reads them.
    expect(bundled).toContain("bring-up");
    expect(bundled).not.toContain("bring-up-managed");
    expect(managed).toContain("bring-up-managed");
    expect(managed).not.toContain("bring-up");

    // A step with no `when` is unconditional under every answer.
    const download = dockerCompose.steps.find((step) => step.id === "download");
    expect(download?.when).toBeUndefined();
    expect(whenMatches(download?.when, {})).toBe(true);

    // The default answers produce a complete, non-empty path.
    expect(applicableSteps(dockerCompose, defaultAnswers(dockerCompose)).length).toBeGreaterThan(0);
  });

  it("carries every Secret as a placeholder plus a recipe, and never a value field", () => {
    expect(model.secrets.length).toBeGreaterThan(1);
    for (const secret of model.secrets) {
      expect(secret).not.toHaveProperty("value");
      expect(secret).not.toHaveProperty("default");
    }
    expect(model.secrets.some((secret) => Boolean(secret.generate))).toBe(true);
  });

  it("labels a settled question with the manifest's own wording for the chosen option", () => {
    const target = model.targets.find((candidate) => candidate.name === "docker-compose");
    if (!target) throw new Error("docker-compose target missing from the wizard model");

    const answers = defaultAnswers(target);
    for (const input of activeInputs(target, answers)) {
      const label = chosenLabel(input, answers);
      const known = input.options.some((option) => option.label === label);
      expect(known, `"${label}" must be one of ${input.id}'s own option labels`).toBe(true);
    }

    // An unanswered question has nothing to say about itself.
    const [first] = activeInputs(target, answers);
    expect(chosenLabel(first, {}), "unanswered questions carry no summary").toBeUndefined();
  });

  it("gives every question a stage of its own, and none to a target that asks nothing", () => {
    const asking = model.targets.filter((target) => (target.inputs ?? []).length > 0);
    const silent = model.targets.filter((target) => (target.inputs ?? []).length === 0);
    expect(asking.length, "some target must ask questions").toBeGreaterThan(0);
    expect(silent.length, "some target must ask nothing").toBeGreaterThan(0);

    for (const target of asking) {
      const answers = defaultAnswers(target);
      const questions = activeInputs(target, answers);
      expect(questions.length, `${target.name} asks more than one question`).toBeGreaterThan(1);
      expect(stageOrder(target, answers)).toEqual([
        "platform",
        ...questions.map((input) => inputStageId(input.id)),
        "steps",
      ]);
    }

    for (const target of silent) {
      expect(
        stageOrder(target, defaultAnswers(target)),
        `${target.name} asks nothing, so it has no question stage`
      ).toEqual(["platform", "steps"]);
    }

    // A question gated behind an answer is not a stage until the answer that reveals it is in.
    const gated = model.targets.find((target) =>
      (target.inputs ?? []).some((input) => input.when !== undefined)
    );
    if (gated) {
      expect(stageOrder(gated, {}).length).toBeLessThan(
        stageOrder(gated, defaultAnswers(gated)).length
      );
    }

    // Before a platform is chosen the questions are not yet knowable.
    expect(stageOrder(null, {})).toEqual(["platform", "steps"]);
  });

  it("makes no network request after load and reports nothing back", () => {
    // A static check over the deploy route's own module graph. If someone adds a fetch, beacon, or
    // analytics call to any file here, this fails — it is not a comment that rots.
    const forbidden = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bnavigator\.sendBeacon\b/,
      /\bEventSource\b/,
      /\bWebSocket\b/,
      /\bnavigator\.geolocation\b/,
      /gtag|googletagmanager|analytics|posthog|plausible|mixpanel|segment/i,
    ];
    for (const source of deployRouteSources()) {
      for (const pattern of forbidden) {
        expect(source, `deploy route source must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

describe("deploy wizard — the static-hosting guarantees", () => {
  const model = buildModel();

  it("renders every input the manifest can declare, so no question is silently dropped", () => {
    // The page draws inputs as radio groups and nothing else. If a manifest ever declares an input
    // this shape cannot express, the reader would lose a decision without being told.
    for (const target of model.targets) {
      for (const input of target.inputs ?? []) {
        expect(
          input.question.length,
          `${target.name}/${input.id} must ask something`
        ).toBeGreaterThan(0);
        expect(
          input.options.length,
          `${target.name}/${input.id} needs at least two options to be a choice`
        ).toBeGreaterThan(1);
        for (const option of input.options) {
          expect(typeof option.label).toBe("string");
          expect(typeof option.value).toBe("string");
        }
      }
    }
  });

  it("never truncates a step title, because the title is the instruction", () => {
    const source = readFileSync(join(DEPLOY_DIR, "step-rail.tsx"), "utf8");
    const heading = source.slice(source.indexOf("<h3"), source.indexOf("</h3>"));
    expect(heading.length, "step-rail.tsx must render a step heading").toBeGreaterThan(0);
    expect(heading, "a step title must wrap, never clip").not.toMatch(/truncate/);
  });

  it("hands the LLM a prompt, not a shell command", () => {
    const source = readFileSync(join(DEPLOY_DIR, "deploy-command.tsx"), "utf8");
    const match = source.match(/const PROMPT = `([\s\S]*?)`/);
    expect(match, "deploy-command.tsx must define a PROMPT").not.toBeNull();
    const prompt = match?.[1] ?? "";

    // What a reader pastes into ChatGPT, Claude Code or Codex is prose addressed to a model.
    expect(prompt, "the prompt must not be a shell command").not.toMatch(/^\s*(curl|wget|\$)/);
    expect(prompt, "the prompt reads as prose").not.toMatch(/-fsSL|\|\s*sh\b/);
    expect(source, "PROMPT_URL must resolve to the published /deploy.txt").toMatch(
      /const PROMPT_URL = `\$\{SITE_URL\}\$\{OPEN_PROMPT\}`/
    );
    expect(prompt.trim().split(/\s+/).length, "the prompt reads as prose").toBeGreaterThan(8);

    // And the copy button has to hand over that prompt, not some other string.
    expect(source).toMatch(/clipboard\.writeText\(PROMPT\)/);
  });
});

describe("deploy wizard — telling the reader what to type", () => {
  const model = buildModel();

  it("carries every command the manifest names into the wizard model", () => {
    const targetsDir = join(ROOT, "deploy/targets");
    let commandsInManifests = 0;

    for (const entry of readdirSync(targetsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = readFileSync(join(targetsDir, entry.name, "manifest.yml"), "utf8");
      const declared = source.match(/^ {4}run:/gm)?.length ?? 0;
      commandsInManifests += declared;

      const target = model.targets.find((candidate) => candidate.name === entry.name);
      expect(target, `${entry.name} must reach the wizard model`).toBeDefined();
      const carried = (target?.steps ?? []).filter((step) => step.run).length;
      expect(
        carried,
        `${entry.name} declares ${declared} commands but the wizard model carries ${carried}`
      ).toBe(declared);
    }

    // A guarantee about the manifests themselves: if every `run` were removed, the assertion above
    // would pass vacuously and the page would silently stop telling anyone what to type.
    expect(commandsInManifests, "some step must name a command").toBeGreaterThan(0);
  });

  it("resolves the site placeholder before a reader can paste the command", () => {
    // The raw model is host-agnostic on purpose, so the placeholder must be there to resolve.
    const raw = JSON.stringify(model);
    expect(raw, "the manifest keeps {{SITE_URL}} unresolved").toContain("{{SITE_URL}}");

    const resolved = JSON.stringify(resolveSiteUrl(model, "https://example.test"));
    expect(resolved, "no placeholder may survive to the page").not.toContain("{{");
    expect(resolved).toContain("https://example.test");
  });

  it("prints the command, not only the check that follows it", () => {
    const source = readFileSync(join(DEPLOY_DIR, "step-rail.tsx"), "utf8");
    expect(source, "a step that names a command must render it").toMatch(/\{step\.run\}/);
    expect(
      source,
      "the verification must read as the follow-up, not as the command itself"
    ).toMatch(/then \$\{verify\.action\}/);
  });
});
