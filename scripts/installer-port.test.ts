import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALLER = join(ROOT, "scripts/install.sh");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tulipfarm-installer-port-"));
  temporaryDirectories.push(directory);
  return directory;
}

function simulatedTerminal(): { inputPath: string; outputPath: string } {
  const directory = temporaryDirectory();
  const inputPath = join(directory, "input");
  const outputPath = join(directory, "output");
  writeFileSync(inputPath, "\n");
  writeFileSync(outputPath, "");
  return { inputPath, outputPath };
}

function runInstallerFunctions(script: string, args: string[] = []): string {
  const harnessPath = join(temporaryDirectory(), "harness.sh");
  writeFileSync(harnessPath, `source "$1"\n${script}`);
  return execFileSync("bash", [harnessPath, INSTALLER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("installer host-port handling", () => {
  it("prompts on the terminal and accepts the suggested free port", () => {
    const terminal = simulatedTerminal();
    const output = runInstallerFunctions(
      `
        PORT=8080
        TTY_INPUT="$2"
        TTY_OUTPUT="$3"
        port_is_in_use() { [ "$1" = 8080 ]; }
        stack_app_owns_port() { return 1; }
        ensure_port_available 0
        printf "%s" "$PORT"
      `,
      [terminal.inputPath, terminal.outputPath]
    );

    expect(output).toContain("Using host port 8081.");
    expect(output.endsWith("8081")).toBe(true);
  });

  it("does not treat the running TulipFarm app as a conflicting process", () => {
    const output = runInstallerFunctions(`
      PORT=8080
      port_is_in_use() { return 0; }
      stack_app_owns_port() { return 0; }
      ensure_port_available 1
      printf "%s" "$PORT"
    `);

    expect(output).toBe("8080");
  });

  it("repairs a failed first install whose saved port was claimed", () => {
    const installDirectory = temporaryDirectory();
    const terminal = simulatedTerminal();
    const envPath = join(installDirectory, ".env");
    writeFileSync(
      envPath,
      [
        "PUBLIC_URL=http://192.168.68.110:8080",
        "CORS_ORIGIN=http://192.168.68.110:8080",
        "HOST_PORT=8080",
        "JWT_SECRET=keep-me",
        "",
      ].join("\n")
    );

    runInstallerFunctions(
      `
        INSTALL_DIR="$2"
        SUDO=""
        PORT_OVERRIDE=""
        PORT=8080
        TTY_INPUT="$3"
        TTY_OUTPUT="$4"
        port_is_in_use() { [ "$1" = 8080 ]; }
        stack_app_owns_port() { return 1; }
        configure_runtime_port
      `,
      [installDirectory, terminal.inputPath, terminal.outputPath]
    );

    expect(readFileSync(envPath, "utf8")).toContain("HOST_PORT=8081\n");
    expect(readFileSync(envPath, "utf8")).toContain("JWT_SECRET=keep-me\n");
  });

  it("honors a new TF_PORT on an existing install and preserves secrets", () => {
    const installDirectory = temporaryDirectory();
    const envPath = join(installDirectory, ".env");
    writeFileSync(
      envPath,
      [
        "PUBLIC_URL=http://192.168.68.110:8080",
        "CORS_ORIGIN=http://192.168.68.110:8080",
        "HOST_PORT=8080",
        "JWT_SECRET=keep-me",
        "",
      ].join("\n")
    );

    runInstallerFunctions(
      `
        INSTALL_DIR="$2"
        SUDO=""
        PORT_OVERRIDE=9000
        PORT=9000
        port_is_in_use() { return 1; }
        configure_runtime_port
      `,
      [installDirectory]
    );

    expect(readFileSync(envPath, "utf8")).toBe(
      [
        "PUBLIC_URL=http://192.168.68.110:9000",
        "CORS_ORIGIN=http://192.168.68.110:9000",
        "HOST_PORT=9000",
        "JWT_SECRET=keep-me",
        "TULIPFARM_VERSION=latest",
        "",
      ].join("\n")
    );
  });

  it("does not rewrite custom reverse-proxy origins when the host port changes", () => {
    const installDirectory = temporaryDirectory();
    const envPath = join(installDirectory, ".env");
    writeFileSync(
      envPath,
      [
        "PUBLIC_URL=https://tulipfarm.example.com",
        "CORS_ORIGIN=https://app.example.com",
        "HOST_PORT=8080",
        "JWT_SECRET=keep-me",
        "",
      ].join("\n")
    );

    runInstallerFunctions(
      `
        INSTALL_DIR="$2"
        SUDO=""
        PORT=9000
        update_runtime_port 8080
      `,
      [installDirectory]
    );

    expect(readFileSync(envPath, "utf8")).toBe(
      [
        "PUBLIC_URL=https://tulipfarm.example.com",
        "CORS_ORIGIN=https://app.example.com",
        "HOST_PORT=9000",
        "JWT_SECRET=keep-me",
        "",
      ].join("\n")
    );
  });
});
