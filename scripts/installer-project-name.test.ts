import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALLER = join(ROOT, "scripts/install.sh");
const COMPOSE_FILE = join(ROOT, "docker-compose.yml");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tulipfarm-project-name-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Sources `install.sh` with a stubbed engine that records its argv, so we assert on the
 * command the installer would actually issue rather than on the variable it computed.
 */
function runInstallerFunctions(script: string, env: Record<string, string> = {}): string {
  const harnessPath = join(temporaryDirectory(), "harness.sh");
  writeFileSync(harnessPath, `source "$1"\n${script}`);
  return execFileSync("bash", [harnessPath, INSTALLER], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("installer compose project name", () => {
  it("defaults to tulipfarm so existing installs keep their volumes", () => {
    const output = runInstallerFunctions(`
      SUDO=""
      ENGINE="echo"
      INSTALL_DIR="$(pwd)"
      compose up -d
    `);

    expect(output.trim()).toBe("compose -p tulipfarm up -d");
  });

  it.each([
    ["TF_PROJECT_NAME", { TF_PROJECT_NAME: "acme" }],
    ["COMPOSE_PROJECT_NAME", { COMPOSE_PROJECT_NAME: "acme" }],
  ])("passes -p from %s so a second business gets its own volumes", (_name, env) => {
    const output = runInstallerFunctions(
      `
      SUDO=""
      ENGINE="echo"
      INSTALL_DIR="$(pwd)"
      compose up -d
    `,
      env
    );

    expect(output.trim()).toBe("compose -p acme up -d");
  });

  it("prefers TF_PROJECT_NAME over COMPOSE_PROJECT_NAME, matching uninstall.sh", () => {
    const output = runInstallerFunctions(
      `
      SUDO=""
      ENGINE="echo"
      INSTALL_DIR="$(pwd)"
      compose up -d
    `,
      { TF_PROJECT_NAME: "acme", COMPOSE_PROJECT_NAME: "globex" }
    );

    expect(output.trim()).toBe("compose -p acme up -d");
  });

  it("records the overridden name in the marker so uninstall targets the right stack", () => {
    const installDirectory = temporaryDirectory();
    runInstallerFunctions(
      `
      SUDO=""
      INSTALL_DIR="$2"
      ENGINE="docker"
      write_install_marker
    `.replace('"$2"', JSON.stringify(installDirectory)),
      { TF_PROJECT_NAME: "acme" }
    );

    const marker = readFileSync(join(installDirectory, ".tulipfarm-install"), "utf8");
    expect(marker).toContain("compose-project=acme");
  });
});

describe("compose file project name", () => {
  it("still pins a name, since renaming it would orphan existing volumes", () => {
    expect(readFileSync(COMPOSE_FILE, "utf8")).toMatch(/^name: tulipfarm$/m);
  });

  it("warns that a second business needs its own project name", () => {
    const header = readFileSync(COMPOSE_FILE, "utf8").split("services:")[0];

    expect(header).toContain("RUNNING MORE THAN ONE BUSINESS ON ONE MACHINE");
    expect(header).toContain("COMPOSE_PROJECT_NAME");
  });
});
