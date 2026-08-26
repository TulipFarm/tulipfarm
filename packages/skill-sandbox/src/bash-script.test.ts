import { describe, expect, it } from "vitest";
import { BASH_STREAM_LIMIT_BYTES, buildBashScript } from "./bash-script";

describe("buildBashScript", () => {
  it("carries the command as base64 rather than interpolating it", () => {
    const command = "echo 'hello'";
    const script = buildBashScript(command);

    expect(script).not.toContain(command);
    expect(script).toContain(Buffer.from(command, "utf8").toString("base64"));
  });

  it("keeps a command that would otherwise close the surrounding quoting inert", () => {
    // The single quote plus `rm -rf /` is exactly the shape that breaks naive interpolation.
    const script = buildBashScript("echo '; rm -rf / #");

    expect(script).not.toContain("rm -rf /");
    expect(script.split("\n").filter((line) => line.includes("base64 -d"))).toHaveLength(1);
  });

  it("embeds only base64-safe characters in the single-quoted payload", () => {
    const script = buildBashScript("node <<'JS'\nconsole.log(1);\nJS");
    const payload = /printf '%s' '([^']*)'/.exec(script);

    expect(payload?.[1]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("exits 0 so a failing command reports its status as data", () => {
    expect(buildBashScript("false").trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("passes the stream cap to the writer", () => {
    expect(buildBashScript("true")).toContain(`TULIP_LIMIT="${BASH_STREAM_LIMIT_BYTES}"`);
  });

  it("writes its result where the sandbox output contract expects it", () => {
    const script = buildBashScript("true");

    expect(script).toContain('os.environ["TULIP_OUTPUT_DIR"]');
    expect(script).toContain('"result.json"');
  });
});
