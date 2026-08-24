import { describe, expect, it } from "vitest";
import {
  type DeploymentTarget,
  DeploymentTargetSchema,
  deploymentTargetIssues,
  parseDeploymentTarget,
  TARGET_TIER_VALUES,
  VERIFY_KIND_VALUES,
  validateDeploymentTarget,
} from "./deployment-target";
import { TulipFarmValidationError } from "./error";

function valid(): DeploymentTarget {
  return {
    name: "docker-compose",
    title: "Docker Compose",
    tier: "supported",
    description: "Run TulipFarm from the published Compose file on any VM or Docker host.",
    summary: "Run TulipFarm from the published Compose file.",
    inputs: [
      {
        id: "database",
        question: "Where does PostgreSQL live?",
        options: [
          { value: "bundled", label: "Bundled container", default: true },
          { value: "managed", label: "A managed Postgres I already have" },
        ],
      },
    ],
    steps: [
      {
        id: "bring-up",
        title: "Start the stack",
        when: { database: "bundled" },
        body: "The reasoning, in prose.",
        run: "docker compose up -d",
        verify: { kind: "http", url: "http://localhost:8080/readyz", expect: 200, timeout: "120s" },
        on_fail: "when-install-fails#readyz",
      },
    ],
    artifacts: [{ id: "compose", references: "docker-compose.yml" }],
  };
}

function corrupt(mutate: (draft: Record<string, unknown>) => void): unknown {
  const draft = JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;
  mutate(draft);
  return draft;
}

type Draft = Record<string, unknown>;

describe("validateDeploymentTarget", () => {
  it("accepts a well-formed target", () => {
    expect(validateDeploymentTarget(valid())).toEqual(valid());
  });

  it("rejects a step that omits verify — a step with no check is where a wizard dead-ends", () => {
    expect(() =>
      validateDeploymentTarget(
        corrupt((d) => {
          delete (d.steps as Draft[])[0].verify;
        })
      )
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects an unknown verify kind — the set is closed so an LLM cannot invent into it", () => {
    expect(() =>
      validateDeploymentTarget(
        corrupt((d) => {
          (d.steps as Draft[])[0].verify = { kind: "smoke", url: "x" };
        })
      )
    ).toThrow(TulipFarmValidationError);
  });

  it("requires look_for on a manual step, so it still carries what to check", () => {
    expect(() =>
      validateDeploymentTarget(
        corrupt((d) => {
          (d.steps as Draft[])[0].verify = { kind: "manual" };
        })
      )
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects an unknown tier, keeping supported and community the only two", () => {
    expect(() => validateDeploymentTarget(corrupt((d) => (d.tier = "beta")))).toThrow(
      TulipFarmValidationError
    );
  });

  it("closes every verify branch, so a misspelt field fails instead of being dropped", () => {
    expect(() =>
      validateDeploymentTarget(
        corrupt((d) => {
          (d.steps as Draft[])[0].verify = {
            kind: "http",
            url: "http://localhost:8080/readyz",
            expect: 200,
            path: "docker-compose.yml",
          };
        })
      )
    ).toThrow(TulipFarmValidationError);
  });
});

describe("DeploymentTargetSchema", () => {
  it("emits tier as a string enum, not anyOf", () => {
    expect(DeploymentTargetSchema.properties.tier).toMatchObject({
      type: "string",
      enum: [...TARGET_TIER_VALUES],
    });
  });

  it("names exactly the closed verify kinds", () => {
    expect([...VERIFY_KIND_VALUES].sort()).toEqual(["command", "env", "file", "http", "manual"]);
  });

  it("accepts a generated artifact declared by a known generator", () => {
    expect(
      validateDeploymentTarget(
        corrupt((d) => {
          d.artifacts = [{ id: "values", filename: "values.yaml", from: "helm-values" }];
        })
      )
    ).toBeTruthy();
  });

  it("rejects a generated artifact naming a generator nobody wrote", () => {
    expect(() =>
      validateDeploymentTarget(
        corrupt((d) => {
          d.artifacts = [{ id: "values", filename: "values.yaml", from: "terraform" }];
        })
      )
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects an artifact that is neither referenced nor generated", () => {
    expect(() =>
      validateDeploymentTarget(
        corrupt((d) => {
          d.artifacts = [{ id: "values", references: "values.yaml", from: "helm-values" }];
        })
      )
    ).toThrow(TulipFarmValidationError);
  });
});

describe("deploymentTargetIssues", () => {
  it("finds nothing wrong with a well-formed target", () => {
    expect(deploymentTargetIssues(valid())).toEqual([]);
  });

  it("rejects a step whose when references an undeclared input", () => {
    const target = valid();
    target.steps[0].when = { exposure: "public" };
    expect(deploymentTargetIssues(target)).toEqual([
      expect.stringContaining('references "exposure", which is not a declared input'),
    ]);
  });

  it("rejects a when that sets a value the input never offered", () => {
    const target = valid();
    target.steps[0].when = { database: "sqlite" };
    expect(deploymentTargetIssues(target)).toEqual([
      expect.stringContaining('database="sqlite", not one of its declared options'),
    ]);
  });

  it("catches duplicate input, step, and artifact ids", () => {
    const target = valid();
    if (target.inputs) target.inputs.push({ ...target.inputs[0] });
    target.steps.push({ ...target.steps[0] });
    if (target.artifacts) target.artifacts.push({ ...target.artifacts[0] });
    expect(deploymentTargetIssues(target)).toEqual([
      expect.stringContaining("inputs: database is declared more than once"),
      expect.stringContaining("steps: bring-up is declared more than once"),
      expect.stringContaining("artifacts: compose is declared more than once"),
    ]);
  });
});

describe("parseDeploymentTarget", () => {
  it("rejects unparseable YAML with a deployment-boundary error", () => {
    expect(() => parseDeploymentTarget("name: x\n  bad: :\n")).toThrow(TulipFarmValidationError);
  });

  it("refuses a manifest that parses but breaks the when rule", () => {
    const source = [
      "name: demo",
      "title: Demo",
      "tier: community",
      "description: A community demo target that reaches the cross-field validation stage.",
      "summary: A demo target.",
      "inputs:",
      "  - id: blob",
      "    question: Where do blobs live?",
      "    options:",
      "      - { value: bundled, label: Bundled }",
      "steps:",
      "  - id: go",
      "    title: Go",
      "    when: { database: bundled }",
      "    verify: { kind: manual, look_for: it worked }",
      "artifacts:",
      "  - { id: compose, references: docker-compose.yml }",
    ].join("\n");
    expect(() => parseDeploymentTarget(source)).toThrow(/not a declared input/);
  });
});
