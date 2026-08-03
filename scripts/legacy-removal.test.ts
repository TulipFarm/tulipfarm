import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
const INVENTORY = readFileSync(join(ROOT, "docs/architecture/legacy-inventory.md"), "utf8");

function legacyPaths(): string[] {
  const paths: string[] = [];
  for (const line of INVENTORY.split("\n")) {
    if (!line.trim().startsWith("| LB-")) continue;
    const pathCell = line.split("|")[3] ?? "";
    paths.push(...[...pathCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
  }
  return paths;
}

describe("legacy removal gate", () => {
  it("removes every path in the accepted legacy inventory", () => {
    const remaining = legacyPaths().filter((path) => existsSync(resolve(ROOT, path)));
    expect(remaining).toEqual([]);
  });

  it("removes runtime dependencies that can recreate direct MCP or Routine bypasses", () => {
    const apiPackage = JSON.parse(readFileSync(join(ROOT, "apps/api/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(apiPackage.dependencies).not.toHaveProperty("@modelcontextprotocol/sdk");
    expect(apiPackage.dependencies).not.toHaveProperty("@tulipfarm/routine-engine");
  });

  it("keeps the production assembly on the canonical durable boundaries", () => {
    const assembly = readFileSync(join(ROOT, "apps/api/src/index.ts"), "utf8");
    for (const forbidden of [
      "McpClientService",
      "RoutineRunDriver",
      "RoutineRunsRepo",
      "ApprovalRegistry",
      "registerIngressJobs",
      "registerStreamGc",
    ]) {
      expect(assembly).not.toContain(forbidden);
    }
    expect(assembly).toContain("DurableInvocationGateway");
  });
});
