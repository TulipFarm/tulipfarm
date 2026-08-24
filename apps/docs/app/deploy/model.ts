import type { WizardModel } from "@tulipfarm/deploy-render";

export type WizardTarget = WizardModel["targets"][number];
export type WizardStep = WizardTarget["steps"][number];
export type WizardInput = NonNullable<WizardTarget["inputs"]>[number];
export type WizardArtifact = NonNullable<WizardTarget["artifacts"]>[number];

/** The answers a reader has given so far: input id → chosen option value. */
export type Answers = Record<string, string>;

/**
 * Every target the model carries, the CI-verified ones first. The `tier` is a **label, not a
 * gate**: the same manifests already publish full step-by-step pages for all of them, so
 * withholding the steps here while showing them in the docs would be incoherent. The wizard offers
 * each one and states the strength of the promise beside it. Ordering by tier is the one place the
 * label does more than describe — a reader with no preference should meet the path we boot in CI
 * before the ones we do not. Read from the model, never from a slug list, so a target added to
 * `deploy/targets/` appears with no interface change.
 */
export function guidedTargets(model: WizardModel): WizardTarget[] {
  return [...model.targets].sort(
    (a, b) => Number(b.tier === "supported") - Number(a.tier === "supported")
  );
}

/**
 * Evaluate a manifest `when` against the reader's answers. The manifest *asserts* the branch as a
 * record of input-id → required option value; this reads that record rather than re-deriving the
 * conditional in the interface, so the guided flow can never disagree with the rendered model
 * (the load-bearing constraint of ticket 10). A missing `when` always applies; a present one
 * applies only when every clause matches an answer already given.
 */
export function whenMatches(when: Record<string, string> | undefined, answers: Answers): boolean {
  if (!when) return true;
  return Object.entries(when).every(([inputId, value]) => answers[inputId] === value);
}

/** The inputs whose own `when` is satisfied — a question the reader has reached and should answer. */
export function activeInputs(target: WizardTarget, answers: Answers): WizardInput[] {
  return (target.inputs ?? []).filter((input) => whenMatches(input.when, answers));
}

/** The steps whose `when` is satisfied by the answers — the reader's path, branch logic and all. */
export function applicableSteps(target: WizardTarget, answers: Answers): WizardStep[] {
  return target.steps.filter((step) => whenMatches(step.when, answers));
}

/** The default answer set: each input's option marked `default`, so a complete path shows at once. */
export function defaultAnswers(target: WizardTarget): Answers {
  const answers: Answers = {};
  for (const input of target.inputs ?? []) {
    const chosen = input.options.find((option) => option.default) ?? input.options[0];
    if (chosen) answers[input.id] = chosen.value;
  }
  return answers;
}

/**
 * What a settled question stage says about itself: the manifest's own label for the chosen option,
 * never a re-wording invented by the page. `undefined` when the question is unanswered.
 */
export function chosenLabel(input: WizardInput, answers: Answers): string | undefined {
  return input.options.find((option) => option.value === answers[input.id])?.label;
}

/** The stages of the walk. Every question the target asks is a stage in its own right. */
export type StageId = "platform" | "steps" | `input:${string}`;

/** The stage that asks one question. */
export function inputStageId(inputId: string): StageId {
  return `input:${inputId}`;
}

/**
 * Which stages the walk has, given the answers so far. Each question gets its own stage so the
 * reader faces one decision at a time instead of a form, and the stages after it renumber to match.
 *
 * This is recomputed from `answers` rather than fixed when the target is chosen, because a question
 * gated behind an earlier answer only becomes a stage once the answer that reveals it is in.
 *
 * With no target chosen the questions are not yet knowable, so only the two stages that always
 * exist are returned.
 */
export function stageOrder(target: WizardTarget | null, answers: Answers): StageId[] {
  if (!target) return ["platform", "steps"];
  return [
    "platform",
    ...activeInputs(target, answers).map((input) => inputStageId(input.id)),
    "steps",
  ];
}

export interface VerifyLine {
  /** What the reader runs or checks. */
  action: string;
  /** What a passing check looks like. */
  expectation: string;
}

/** Render a step's verification as *run this, expect this* — the closed set of verify kinds. */
export function verifyLine(verify: WizardStep["verify"]): VerifyLine {
  switch (verify.kind) {
    case "http":
      return {
        action: `GET ${verify.url}`,
        expectation: `responds ${verify.expect}${verify.timeout ? ` within ${verify.timeout}` : ""}`,
      };
    case "command":
      return {
        action: verify.command,
        expectation: verify.expect ? verify.expect : "the command exits 0",
      };
    case "file":
      return {
        action: "look in the working directory",
        expectation: `${verify.path} is present`,
      };
    case "env":
      return {
        action: "read the environment",
        expectation: `${verify.name} is set`,
      };
    case "manual":
      return {
        action: "confirm by eye",
        expectation: verify.look_for,
      };
  }
}

/** A GitHub-slugger-shaped anchor for a step heading, matching the generated MDX page's ids. */
export function stepAnchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\da-z\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** The generated self-hosting page for a target, optionally deep-linked to one step's full prose. */
export function targetDocHref(target: WizardTarget, step?: WizardStep): string {
  const base = `/docs/self-hosting/${target.name}`;
  return step ? `${base}#${stepAnchor(step.title)}` : base;
}

/** Where a referenced or generated artifact is served from the static site's domain root. */
export function artifactHref(artifact: WizardArtifact): string {
  return "references" in artifact ? `/${artifact.references}` : `/${artifact.filename}`;
}

/** The served filename a reader downloads, shown as the link label. */
export function artifactName(artifact: WizardArtifact): string {
  return "references" in artifact ? artifact.references : artifact.filename;
}

/**
 * Resolve the manifest's `{{SITE_URL}}` placeholder throughout a rendered model.
 *
 * Every surface resolves it at its own boundary — the docs pages and `deploy.txt` do it as they are
 * written to disk — because the manifest itself must stay host-agnostic. The wizard's boundary is
 * the page's export, so without this a reader would be shown a command with a literal
 * `{{SITE_URL}}` in it and paste it verbatim.
 */
export function resolveSiteUrl<T>(value: T, siteUrl: string): T {
  if (typeof value === "string") return value.replaceAll("{{SITE_URL}}", siteUrl) as T;
  if (Array.isArray(value)) return value.map((entry) => resolveSiteUrl(entry, siteUrl)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveSiteUrl(entry, siteUrl)])
    ) as T;
  }
  return value;
}
