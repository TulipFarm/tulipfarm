import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { createRuntimeCapabilityAdvertisement } from "../src/capabilities.mjs";
import { runConformance } from "../src/conformance.mjs";

function manifest() {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      description: "Read weather.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    operations: [
      {
        id: "weather",
        name: "read_weather",
        description: "Read weather.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.example.test",
          path: "/weather",
        },
        response: { schema: { type: "object" }, maxBytes: 4096 },
      },
    ],
  };
}

const referenceAdapter = {
  async runCase(vector) {
    const input = vector.input;
    switch (vector.caseId) {
      case "core.manifest.strict":
        try {
          validateManifestSource(input.source);
          return { accepted: true };
        } catch {
          return { accepted: false };
        }
      case "core.package.exact-files": {
        const value = manifest();
        value.files = [{ path: "guide.md", role: "guide", sha256: oimFileDigest("guide") }];
        const files = new Map(
          input.present.map((path) => [path, path === "guide.md" ? "guide" : "x"])
        );
        const issues = oimPackageIssues(value, files);
        return {
          accepted: issues.length === 0,
          undeclared: input.present.filter((path) => !input.declared.includes(path)),
        };
      }
      case "core.operation.http":
        if (input.operation === "native-http") {
          const url = new URL("https://api.example.test/weather");
          url.searchParams.set("city", input.arguments.city);
          return {
            method: "GET",
            url: url.href,
            result: input.response,
            destinationGuard: url.protocol === "https:" ? "passed" : "failed",
            authorization: "authorized",
            connection: "ready",
            credentialInjected: true,
          };
        }
        if (input.operation === "form-http") {
          return {
            contentType: "application/x-www-form-urlencoded",
            body: new URLSearchParams(input.arguments.body).toString(),
            result: input.response,
          };
        }
        return {
          parts: Object.entries(input.arguments.body).map(([name, value]) => ({
            name: name === "fileId" ? "document" : name,
            kind: name === "fileId" && typeof value === "string" ? "file" : "field",
          })),
          result: input.response,
        };
      case "core.operation.openapi":
        return {
          method: "GET",
          url: `https://api.example.test/pets/${encodeURIComponent(input.arguments.id)}`,
          result: input.response,
        };
      case "core.operation.graphql":
        return {
          operation: input.operation,
          variables: input.variables,
          result: input.response,
        };
      case "core.fixtures.hermetic": {
        const suite = `version: 1
cases:
  - name: weather
    operationId: weather
    request: { city: Paris }
    response: { status: 200, body: { temperature: 18 } }
    expect:
      request: { method: GET, url: https://api.example.test/weather?city=Paris }
      result: { temperature: 18 }
`;
        validateFixtureSuiteSource(suite);
        return { passed: input.request.city === "Paris", networkCalls: 0 };
      }
      case "core.compatibility.same-major": {
        const previous = manifest();
        if (input.change === "wider-http-parameter") {
          previous.operations[0].source.parameters = [
            {
              name: "units",
              in: "query",
              required: true,
              schema: { type: "string", enum: ["metric"] },
            },
          ];
        }
        const next = structuredClone(previous);
        next.metadata.version = input.next;
        if (input.change === "required-input") {
          next.operations[0].requestSchema = {
            type: "object",
            properties: { requiredValue: { type: "string" } },
            required: ["requiredValue"],
          };
        } else if (input.change === "required-http-parameter") {
          next.operations[0].source.parameters = [
            {
              name: "tenant",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ];
        } else if (input.change === "wider-http-parameter") {
          next.operations[0].source.parameters[0] = {
            name: "units",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["metric", "imperial"] },
          };
        }
        return { compatible: oimCompatibilityIssues(previous, next).length === 0 };
      }
      default:
        throw new Error(`unsupported reference vector ${vector.id}`);
    }
  },
};

import {
  OIM_ENTRYPOINT,
  OIM_PROFILE_VERSION_MATRIX,
  OimManifestSchema,
  oimCompatibilityIssues,
  oimFileDigest,
  oimPackageIssues,
  validateConformanceClaim,
  validateFixtureSuiteSource,
  validateManifestSource,
  validatePackageDirectory,
} from "../src/index.mjs";

test("the portable package imports without a private runtime", () => {
  assert.equal(OIM_ENTRYPOINT, "oim.yml");
  assert.equal(typeof validateManifestSource, "function");
});

test("the public profile matrix comes from the generated manifest schema", () => {
  const profileProperties = OimManifestSchema.properties.profiles.properties;
  for (const [profile, versions] of Object.entries(OIM_PROFILE_VERSION_MATRIX)) {
    assert.deepEqual(versions, profileProperties[profile].enum);
  }
});

test("the package export resolves to the standalone API", async () => {
  const packageApi = await import("@oim-standard/conformance");
  assert.equal(packageApi.OIM_ENTRYPOINT, "oim.yml");
});

test("the generated runtime imports no private package", async () => {
  const source = await readFile(new URL("../dist/oim-runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s*["'](?:@tulipfarm|\.\.?\/)/);
});

test("the conformance API loads from the production CommonJS bundle shape", async () => {
  const root = new URL("../", import.meta.url);
  const output = new URL("../.test-work/image/conformance.cjs", import.meta.url);
  await mkdir(dirname(fileURLToPath(output)), { recursive: true });
  try {
    const build = spawnSync(
      "pnpm",
      [
        "exec",
        "esbuild",
        "src/conformance.mjs",
        "--bundle",
        "--packages=external",
        "--platform=node",
        "--format=cjs",
        "--target=node22",
        `--outfile=${fileURLToPath(output)}`,
      ],
      { cwd: fileURLToPath(root), encoding: "utf8" }
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const load = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(fileURLToPath(output))})`],
      { encoding: "utf8" }
    );
    assert.equal(load.status, 0, load.stderr);
  } finally {
    await rm(new URL("../.test-work/image/", import.meta.url), { recursive: true, force: true });
  }
});

test("the Docker context preserves only the generated OIM runtime under dist", async () => {
  const lines = (await readFile(new URL("../../../.dockerignore", import.meta.url), "utf8"))
    .split("\n")
    .filter((line) => line.includes("standards/oim/dist"));
  assert.deepEqual(lines, ["!standards/oim/dist/", "!standards/oim/dist/oim-runtime.mjs"]);
});

test("the production package contains the generated semantic runtime", () => {
  const result = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout);
  assert.ok(packed.files.some((file) => file.path === "dist/oim-runtime.mjs"));
});

test("every distributed JSON Schema compiles", async () => {
  const root = new URL("../schemas/", import.meta.url);
  const files = await readdir(root, { recursive: true });
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const schema = JSON.parse(await readFile(new URL(file, root), "utf8"));
    assert.doesNotThrow(() => ajv.compile(schema), file);
  }
});

test("portable positive and negative manifest vectors have the declared result", async () => {
  const index = JSON.parse(
    await readFile(new URL("../vectors/manifest/index.json", import.meta.url))
  );
  for (const vector of index.vectors) {
    const source = await readFile(
      new URL(`../vectors/manifest/${vector.file}`, import.meta.url),
      "utf8"
    );
    assert.equal(
      (() => {
        try {
          validateManifestSource(source);
          return true;
        } catch {
          return false;
        }
      })(),
      vector.valid,
      vector.file
    );
  }
});

test("portable fixture vectors remain hermetic", async () => {
  const index = JSON.parse(
    await readFile(new URL("../vectors/fixtures/index.json", import.meta.url))
  );
  for (const vector of index.vectors) {
    const source = await readFile(
      new URL(`../vectors/fixtures/${vector.file}`, import.meta.url),
      "utf8"
    );
    assert.equal(
      (() => {
        try {
          validateFixtureSuiteSource(source);
          return true;
        } catch {
          return false;
        }
      })(),
      vector.valid,
      vector.file
    );
  }
});

test("a package has exactly one oim.yml entrypoint", async () => {
  const directory = new URL("../.test-work/package/", import.meta.url);
  try {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const source = await readFile(
      new URL("../vectors/manifest/positive/core-1.0.yml", import.meta.url),
      "utf8"
    );
    await writeFile(new URL("oim.yml", directory), source);
    assert.equal((await validatePackageDirectory(directory)).manifest.profiles.core, "1.0");

    await writeFile(new URL("manifest.yml", directory), source);
    await assert.rejects(validatePackageDirectory(directory), /manifest\.yml is not allowed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an incomplete profile claim is rejected", async () => {
  const claim = JSON.parse(
    await readFile(new URL("../vectors/claims/core-incomplete.invalid.json", import.meta.url))
  );
  assert.throws(() => validateConformanceClaim(claim), /missing core\.compatibility\.same-major/);
});

test("a runtime cannot claim an untested optional profile", async () => {
  const claim = JSON.parse(
    await readFile(new URL("../vectors/claims/core-complete.valid.json", import.meta.url))
  );
  claim.profiles.auth = "1.0";
  assert.throws(() => validateConformanceClaim(claim), /missing auth\.fields\.secure-submit/);
});

test("a runtime cannot report cases for an unclaimed profile", async () => {
  const claim = JSON.parse(
    await readFile(new URL("../vectors/claims/core-complete.valid.json", import.meta.url))
  );
  claim.passedCases.push("auth.fields.secure-submit");
  assert.throws(
    () => validateConformanceClaim(claim),
    /auth\.fields\.secure-submit is not claimed/
  );
});

test("capability advertisements require an executed conformance report", async () => {
  const report = await runConformance({
    runtime: { name: "Example Runtime", version: "2.0.0" },
    profiles: { core: "1.2" },
    adapter: referenceAdapter,
  });
  const advertisement = createRuntimeCapabilityAdvertisement(report);
  assert.deepEqual(advertisement.profiles.core, ["1.0", "1.1", "1.2"]);
  assert.equal(advertisement.packageEntrypoint, "oim.yml");

  const incomplete = structuredClone(report);
  incomplete.results.pop();
  assert.throws(
    () => createRuntimeCapabilityAdvertisement(incomplete),
    /report does not prove every claimed case/
  );
});

test("the conformance runner executes every vector before issuing a claim", async () => {
  const calls = [];
  const report = await runConformance({
    runtime: { name: "Example Runtime", version: "2.0.0" },
    profiles: { core: "1.0" },
    adapter: {
      async runCase(vector) {
        assert.equal(Object.hasOwn(vector, "expect"), false);
        calls.push(vector.id);
        return referenceAdapter.runCase(vector);
      },
    },
  });

  assert.equal(report.claim.profiles.core, "1.0");
  assert.equal(calls.length, report.results.length);
  assert.ok(report.results.every((result) => result.status === "passed"));
});

test("the conformance runner refuses behavior that does not match a vector", async () => {
  await assert.rejects(
    runConformance({
      runtime: { name: "Example Runtime", version: "2.0.0" },
      profiles: { core: "1.0" },
      adapter: {
        async runCase() {
          return { accepted: true };
        },
      },
    }),
    /conformance failed/
  );
});

test("the conformance runner refuses skipped behavior", async () => {
  await assert.rejects(
    runConformance({
      runtime: { name: "Example Runtime", version: "2.0.0" },
      profiles: { core: "1.0" },
      adapter: {
        async runCase() {
          return { skipped: true };
        },
      },
    }),
    /conformance failed/
  );
});

test("the command line validates a standalone package", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("../bin/oim.mjs", import.meta.url).pathname,
      "validate-claim",
      new URL("../vectors/claims/core-complete.valid.json", import.meta.url).pathname,
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"core": "1\.0"/);
});
