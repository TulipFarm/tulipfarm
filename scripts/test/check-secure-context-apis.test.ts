import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = join(process.cwd(), "scripts/test/check-secure-context-apis.sh");

async function runGuard(scanDir: string) {
  return execFileAsync("bash", [script], {
    env: { ...process.env, SECURE_CONTEXT_SCAN_DIR: scanDir },
  });
}

describe("secure-context API guard", () => {
  it("rejects direct calls while allowing tests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-secure-context-"));
    await writeFile(join(dir, "bad.ts"), "export const id = crypto.randomUUID();\n");
    await expect(runGuard(dir)).rejects.toMatchObject({ code: 1 });

    await writeFile(join(dir, "bad.ts"), "export const id = randomUUID();\n");
    await writeFile(join(dir, "helper.test.ts"), "crypto.randomUUID();\n");
    await expect(runGuard(dir)).resolves.toMatchObject({
      stdout: expect.stringContaining("ok"),
    });
  });

  it("keeps the clipboard and report-bug helper exemptions explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-secure-context-"));
    const helperDir = join(dir, "app/lib");
    await mkdir(helperDir, { recursive: true });
    await writeFile(join(helperDir, "clipboard.ts"), "navigator.clipboard.writeText('x');\n");
    await writeFile(
      join(helperDir, "report-bug.ts"),
      "navigator.mediaDevices.getDisplayMedia({ video: true });\n"
    );
    await expect(runGuard(dir)).resolves.toMatchObject({
      stdout: expect.stringContaining("ok"),
    });
  });
});
