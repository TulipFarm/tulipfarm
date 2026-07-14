import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverIntegrations } from "./routes";

const TMP = join(__dirname, "__discover_test_tmp__");

async function write(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

const BASE_MANIFEST = [
  "name: chatapp",
  "egress:",
  "  type: mcp",
  "  entry:",
  "    transport: stdio",
  "    command: echo",
].join("\n");

beforeEach(() => mkdir(TMP, { recursive: true }));
afterEach(() => rm(TMP, { recursive: true, force: true }));

describe("discoverIntegrations — ingress handler", () => {
  it("reads the manifest-declared ingress handler beside the manifest", async () => {
    const handler = "({ classify(ctx) { return { kind: 'ignore' }; } })";
    await write(
      join(TMP, "chatapp", "manifest.yml"),
      `${BASE_MANIFEST}\ningress:\n  handler: ingress.ts\n`
    );
    await write(join(TMP, "chatapp", "ingress.ts"), handler);

    const found = await discoverIntegrations(TMP);
    expect(found).toHaveLength(1);
    expect(found[0].ingressHandlerContent).toBe(handler);
  });

  it("leaves ingressHandlerContent unset when no handler is declared or the file is missing", async () => {
    await write(join(TMP, "plain", "manifest.yml"), BASE_MANIFEST);
    await write(
      join(TMP, "declared-missing", "manifest.yml"),
      `${BASE_MANIFEST.replace("chatapp", "declared-missing")}\ningress:\n  handler: ingress.ts\n`
    );
    const found = await discoverIntegrations(TMP);
    expect(found).toHaveLength(2);
    for (const integration of found) {
      expect(integration.ingressHandlerContent).toBeUndefined();
    }
  });

  it("confines the handler read to the integration dir (basename only)", async () => {
    await write(join(TMP, "outside.ts"), "({ classify() {} })");
    await write(
      join(TMP, "sneaky", "manifest.yml"),
      `${BASE_MANIFEST.replace("chatapp", "sneaky")}\ningress:\n  handler: ../outside.ts\n`
    );
    const found = await discoverIntegrations(TMP);
    // ../outside.ts is reduced to outside.ts inside sneaky/ → missing → unset.
    expect(found[0].ingressHandlerContent).toBeUndefined();
  });
});
