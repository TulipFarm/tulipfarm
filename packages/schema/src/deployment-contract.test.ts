import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DeploymentContract,
  DeploymentContractSchema,
  deploymentContractIssues,
  ENV_CONSUMER_VALUES,
  ENV_ZONE_VALUES,
  parseDeploymentContract,
  validateDeploymentContract,
} from "./deployment-contract";
import { TulipFarmValidationError } from "./error";

function valid(): DeploymentContract {
  return {
    version: 1,
    services: [
      { name: "app", role: "API and web UI", port: 8080, health: { path: "/readyz", expect: 200 } },
    ],
    dependencies: [{ id: "postgres", required: true, detail: "PostgreSQL 17 with pgvector" }],
    state: [
      {
        path: "TF_DATA_DIR",
        holds: "Generated secrets",
        durability: "Must survive restart and upgrade",
        consequence: "Losing it loses every stored Secret",
      },
    ],
    env: [
      {
        name: "DATABASE_URL",
        zone: "set-these",
        consumers: ["app"],
        description: "PostgreSQL connection string",
        consequence: "Without it the process cannot start",
        required: true,
      },
    ],
  };
}

/** A record shape loose enough to hold a deliberately invalid contract. */
function corrupt(mutate: (draft: Record<string, unknown>) => void): unknown {
  const draft = JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;
  mutate(draft);
  return draft;
}

describe("validateDeploymentContract", () => {
  it("accepts a well-formed contract", () => {
    expect(validateDeploymentContract(valid())).toEqual(valid());
  });

  it("rejects a version other than 1, so an old reader cannot silently read a new shape", () => {
    expect(() => validateDeploymentContract(corrupt((d) => (d.version = 2)))).toThrow(
      TulipFarmValidationError
    );
  });

  it.each([
    ["an env name that is not SCREAMING_SNAKE_CASE", (d: Env) => (d.name = "databaseUrl")],
    ["an unknown zone", (d: Env) => (d.zone = "sometimes-set")],
    ["an unknown consumer", (d: Env) => (d.consumers = ["cron"])],
    ["no consumers at all", (d: Env) => (d.consumers = [])],
    ["a missing consequence", (d: Env) => delete d.consequence],
    ["a missing description", (d: Env) => delete d.description],
    ["an empty description", (d: Env) => (d.description = "")],
    ["a misspelt field", (d: Env) => (d.secrets = true)],
  ])("rejects %s", (_label, mutate) => {
    const data = corrupt((draft) => {
      mutate((draft.env as Env[])[0]);
    });
    expect(() => validateDeploymentContract(data)).toThrow(TulipFarmValidationError);
  });

  it("tags the failure to the deployment boundary and names the offending path", () => {
    const data = corrupt((d) => {
      (d.env as Env[])[0].name = "databaseUrl";
    });
    try {
      validateDeploymentContract(data);
      expect.unreachable("expected a validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(TulipFarmValidationError);
      expect((error as TulipFarmValidationError).boundary).toBe("deployment");
      expect((error as TulipFarmValidationError).path).toContain("/env/0/name");
    }
  });

  it("rejects an unknown top-level section rather than ignoring it", () => {
    expect(() => validateDeploymentContract(corrupt((d) => (d.targets = [])))).toThrow(
      TulipFarmValidationError
    );
  });

  it("rejects a contract with no environment variables", () => {
    expect(() => validateDeploymentContract(corrupt((d) => (d.env = [])))).toThrow(
      TulipFarmValidationError
    );
  });
});

type Env = Record<string, unknown>;

describe("DeploymentContractSchema", () => {
  const envProperties = DeploymentContractSchema.properties.env.items.properties;

  it("emits zone and consumer as string enums, not anyOf", () => {
    expect(envProperties.zone).toMatchObject({ type: "string", enum: [...ENV_ZONE_VALUES] });
    expect(envProperties.consumers.items).toMatchObject({
      type: "string",
      enum: [...ENV_CONSUMER_VALUES],
    });
  });

  it("closes every object, so a misspelt key fails instead of being dropped", () => {
    expect(DeploymentContractSchema.additionalProperties).toBe(false);
    expect(DeploymentContractSchema.properties.env.items.additionalProperties).toBe(false);
    expect(DeploymentContractSchema.properties.services.items.additionalProperties).toBe(false);
  });
});

describe("deploymentContractIssues", () => {
  it("finds nothing wrong with a well-formed contract", () => {
    expect(deploymentContractIssues(valid())).toEqual([]);
  });

  it("catches a variable declared twice", () => {
    const contract = valid();
    contract.env.push({ ...contract.env[0] });
    expect(deploymentContractIssues(contract)).toEqual([
      expect.stringContaining("declared more than once"),
    ]);
  });

  it("catches a Secret parked in never-set, which cannot both hold a key and never be set", () => {
    const contract = valid();
    contract.env[0] = { ...contract.env[0], zone: "never-set", secret: true, required: undefined };
    delete (contract.env[0] as Env).required;
    expect(deploymentContractIssues(contract)).toEqual([
      expect.stringContaining('"never set this" is incoherent'),
    ]);
  });

  it("catches a generate recipe on a value nobody treats as a Secret", () => {
    const contract = valid();
    contract.env[0] = { ...contract.env[0], generate: "openssl rand -base64 32" };
    expect(deploymentContractIssues(contract)).toEqual([
      expect.stringContaining("declares generate but is not marked secret"),
    ]);
  });

  it("catches a never-set variable that is also required", () => {
    const contract = valid();
    contract.env[0] = { ...contract.env[0], zone: "never-set", required: true };
    expect(deploymentContractIssues(contract)).toEqual([
      expect.stringContaining("cannot also be required"),
    ]);
  });

  it("catches duplicate service names and dependency ids", () => {
    const contract = valid();
    contract.services.push({ ...contract.services[0] });
    contract.dependencies.push({ ...contract.dependencies[0] });
    expect(deploymentContractIssues(contract)).toEqual([
      expect.stringContaining("services: app is declared twice"),
      expect.stringContaining("dependencies: postgres is declared twice"),
    ]);
  });

  it("reports every violation at once, so a contributor fixes them in one pass", () => {
    const contract = valid();
    contract.env.push({ ...contract.env[0] });
    contract.services.push({ ...contract.services[0] });
    expect(deploymentContractIssues(contract)).toHaveLength(2);
  });
});

describe("parseDeploymentContract", () => {
  it("rejects unparseable YAML with a deployment-boundary error", () => {
    expect(() => parseDeploymentContract("version: 1\n  services: oops\n")).toThrow(
      TulipFarmValidationError
    );
  });

  it("refuses a contract that parses but breaks a cross-field rule", () => {
    const source = [
      "version: 1",
      "services: [{ name: app, role: API }]",
      "dependencies: [{ id: postgres, required: true, detail: PostgreSQL }]",
      "state: [{ path: TF_DATA_DIR, holds: keys, durability: durable, consequence: loss }]",
      "env:",
      "  - name: JWT_SECRET",
      "    zone: never-set",
      "    consumers: [app]",
      "    description: Signing secret",
      "    consequence: Rotating it signs everyone out",
      "    secret: true",
    ].join("\n");
    expect(() => parseDeploymentContract(source)).toThrow(/never set this/);
  });
});

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

/**
 * The schema is only worth having if the file it describes actually obeys it. Without this, the
 * contract could drift out of shape and every test above would still pass.
 */
describe("deploy/contract.yml", () => {
  const contract = parseDeploymentContract(
    readFileSync(join(repoRoot(), "deploy", "contract.yml"), "utf8")
  );

  it("declares the three long-running services", () => {
    expect(contract.services.map((service) => service.name).sort()).toEqual([
      "app",
      "integration-worker",
      "worker",
    ]);
  });

  it("declares postgres and blob storage", () => {
    expect(contract.dependencies.map((dependency) => dependency.id).sort()).toEqual([
      "blob",
      "postgres",
    ]);
  });

  it("describes a real environment surface rather than an empty placeholder", () => {
    expect(contract.env.length).toBeGreaterThan(50);
  });

  it("uses only the declared zone and consumer vocabularies", () => {
    for (const variable of contract.env) {
      expect(ENV_ZONE_VALUES).toContain(variable.zone);
      for (const consumer of variable.consumers) expect(ENV_CONSUMER_VALUES).toContain(consumer);
    }
  });

  it("names the variables without which nothing boots", () => {
    const names = new Set(contract.env.map((variable) => variable.name));
    for (const required of ["DATABASE_URL", "ENCRYPTION_KEY", "JWT_SECRET", "SOUL_PATH"]) {
      expect(names).toContain(required);
    }
  });

  it("marks every generated key as a Secret and gives it a recipe", () => {
    const generated = contract.env.filter((variable) => variable.generate);
    expect(generated.length).toBeGreaterThan(0);
    for (const variable of generated) expect(variable.secret).toBe(true);
  });
});
