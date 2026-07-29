import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const UNINSTALLER = join(ROOT, "scripts/uninstall.sh");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tulipfarm-uninstaller-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeHarness(script: string): string {
  const path = join(temporaryDirectory(), "harness.sh");
  writeFileSync(path, `source "$1"\n${script}`);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("production uninstaller", () => {
  it("requires the complete typed confirmation phrase", () => {
    const terminalDirectory = temporaryDirectory();
    const inputPath = join(terminalDirectory, "input");
    const outputPath = join(terminalDirectory, "output");
    writeFileSync(inputPath, "uninstall\n");
    writeFileSync(outputPath, "");
    const harness = writeHarness(`
      ASSUME_YES=false
      PROJECT_NAME=tulipfarm
      INSTALL_DIR=/opt/tulipfarm
      TTY_INPUT="$2"
      TTY_OUTPUT="$3"
      confirm_uninstall
    `);

    const result = spawnSync("bash", [harness, UNINSTALLER, inputPath, outputPath], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nothing was removed");
    expect(readFileSync(outputPath, "utf8")).toContain("uninstall tulipfarm");
  });

  it("accepts the exact typed confirmation phrase", () => {
    const terminalDirectory = temporaryDirectory();
    const inputPath = join(terminalDirectory, "input");
    const outputPath = join(terminalDirectory, "output");
    writeFileSync(inputPath, "uninstall tulipfarm\n");
    writeFileSync(outputPath, "");
    const harness = writeHarness(`
      ASSUME_YES=false
      PROJECT_NAME=tulipfarm
      INSTALL_DIR=/opt/tulipfarm
      TTY_INPUT="$2"
      TTY_OUTPUT="$3"
      confirm_uninstall
    `);

    const result = spawnSync("bash", [harness, UNINSTALLER, inputPath, outputPath], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  it("refuses broad and symlinked install directories", () => {
    const target = temporaryDirectory();
    const link = join(temporaryDirectory(), "linked-install");
    execFileSync("ln", ["-s", target, link]);
    const harness = writeHarness(`
      INSTALL_DIR="$2"
      validate_install_dir
    `);

    const rootResult = spawnSync("bash", [harness, UNINSTALLER, "/"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const linkResult = spawnSync("bash", [harness, UNINSTALLER, link], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(rootResult.status).toBe(1);
    expect(rootResult.stderr).toContain("unsafe install directory");
    expect(linkResult.status).toBe(1);
    expect(linkResult.stderr).toContain("symlinked install directory");
  });

  it("purges project resources and verifies the managed directory is gone", () => {
    const state = temporaryDirectory();
    const installDirectory = temporaryDirectory();
    const commandLog = join(state, "commands");
    const containers = join(state, "containers");
    const volumes = join(state, "volumes");
    const networks = join(state, "networks");
    const images = join(state, "images");
    const imageIds = join(state, "image-ids");
    writeFileSync(
      join(installDirectory, ".tulipfarm-install"),
      "managed-by=tulipfarm-installer\ncompose-project=tf-test\nruntime=docker\n"
    );
    writeFileSync(join(installDirectory, ".env"), "JWT_SECRET=secret\n");
    writeFileSync(containers, "app-container\npostgres-container\n");
    writeFileSync(
      volumes,
      ["tf-test_tulipfarm-postgres", "tf-test_tulipfarm-soul", "tf-test_tulipfarm-data", ""].join(
        "\n"
      )
    );
    writeFileSync(networks, "tf-test_default\n");
    writeFileSync(images, "ghcr.io/tulipfarm/tulipfarm:latest\n");
    writeFileSync(imageIds, "sha-app\nsha-postgres\n");
    writeFileSync(commandLog, "");

    const harness = writeHarness(`
      STATE="$2"
      INSTALL_DIR="$3"
      RUNTIME_OVERRIDE=docker
      docker() { :; }
      runtime_is_available() { [ "$1" = docker ]; }
      remove_state_line() {
        grep -vxF "$2" "$1" > "$1.tmp" || true
        mv "$1.tmp" "$1"
      }
      runtime() {
        local engine="$1"
        shift
        printf "%s\\n" "$*" >> "$STATE/commands"
        case "$1" in
          ps)
            [ -s "$STATE/containers" ] && cat "$STATE/containers"
            ;;
          inspect)
            case "\${*: -1}" in
              app-container) printf "sha-app\\n" ;;
              postgres-container) printf "sha-postgres\\n" ;;
              *) return 1 ;;
            esac
            ;;
          rm)
            remove_state_line "$STATE/containers" "$3"
            ;;
          volume)
            case "$2" in
              ls) [ -s "$STATE/volumes" ] && cat "$STATE/volumes" ;;
              rm) remove_state_line "$STATE/volumes" "$3" ;;
              inspect) grep -qxF "$3" "$STATE/volumes" ;;
            esac
            ;;
          network)
            case "$2" in
              ls) [ -s "$STATE/networks" ] && cat "$STATE/networks" ;;
              rm) remove_state_line "$STATE/networks" "$3" ;;
              inspect) grep -qxF "$3" "$STATE/networks" ;;
            esac
            ;;
          image)
            case "$2" in
              ls) [ -s "$STATE/images" ] && cat "$STATE/images" ;;
              inspect) grep -qxF "$3" "$STATE/image-ids" ;;
              rm)
                case "$3" in
                  ghcr.io/tulipfarm/tulipfarm:*)
                    : > "$STATE/images"
                    remove_state_line "$STATE/image-ids" sha-app
                    ;;
                  *) remove_state_line "$STATE/image-ids" "$3" ;;
                esac
                ;;
            esac
            ;;
          *) return 1 ;;
        esac
      }
      main --yes
    `);

    const output = execFileSync("bash", [harness, UNINSTALLER, state, installDirectory], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(output).toContain("completely removed");
    expect(readFileSync(containers, "utf8")).toBe("");
    expect(readFileSync(volumes, "utf8")).toBe("");
    expect(readFileSync(networks, "utf8")).toBe("");
    expect(readFileSync(images, "utf8")).toBe("");
    expect(readFileSync(imageIds, "utf8")).toBe("");
    expect(() => readFileSync(installDirectory)).toThrow();
    expect(readFileSync(commandLog, "utf8")).toContain("label=com.docker.compose.project=tf-test");
  });
});
