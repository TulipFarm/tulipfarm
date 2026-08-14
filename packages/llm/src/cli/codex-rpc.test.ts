import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRpc, CodexRpcError } from "./codex-rpc";

/** Tests transport-only child failures that `codex.test.ts` cannot reach. */

let workDir: string;
const open: CodexRpc[] = [];

function child(body: string): string {
  const path = join(workDir, `child-${open.length}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, body);
  return path;
}

function connect(
  scriptPath: string,
  handlers: Partial<{
    onNotification(method: string, params: unknown): void;
    onRequest(method: string, params: unknown): Promise<unknown>;
    onClose(error: Error): void;
  }> = {}
): CodexRpc {
  const rpc = new CodexRpc({
    scriptPath,
    cwd: workDir,
    env: { ...process.env },
    onNotification: handlers.onNotification ?? (() => {}),
    onRequest: handlers.onRequest ?? (async () => ({})),
    ...(handlers.onClose ? { onClose: handlers.onClose } : {}),
  });
  open.push(rpc);
  return rpc;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "tf-codex-rpc-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((rpc) => rpc.close().catch(() => undefined)));
  rmSync(workDir, { recursive: true, force: true });
});

const ECHO = `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ id: message.id, result: { echoed: message.method } }) + "\\n");
  }
});
`;

describe("request/response", () => {
  it("matches responses to their requests, even out of order", async () => {
    const rpc = connect(
      child(`
import { createInterface } from "node:readline";
const seen = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  seen.push(JSON.parse(line));
  if (seen.length < 2) return;
  // Answer in reverse: correlation must come from the id, never from arrival order.
  for (const message of seen.reverse()) {
    process.stdout.write(JSON.stringify({ id: message.id, result: { method: message.method } }) + "\\n");
  }
});
`)
    );

    const [first, second] = await Promise.all([
      rpc.request<{ method: string }>("alpha"),
      rpc.request<{ method: string }>("beta"),
    ]);

    expect(first.method).toBe("alpha");
    expect(second.method).toBe("beta");
  });

  it("reassembles a response written in fragments", async () => {
    // The child's stdout is a stream, not a message queue: a reply can arrive split mid-token.
    const rpc = connect(
      child(`
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id } = JSON.parse(line);
  const reply = JSON.stringify({ id, result: { value: "whole" } });
  process.stdout.write(reply.slice(0, 7));
  setTimeout(() => process.stdout.write(reply.slice(7) + "\\n"), 20);
});
`)
    );

    await expect(rpc.request<{ value: string }>("thing")).resolves.toEqual({ value: "whole" });
  });

  it("surfaces a JSON-RPC error as CodexRpcError", async () => {
    const rpc = connect(
      child(`
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id, error: { code: -32601, message: "no such method" } }) + "\\n");
});
`)
    );

    await expect(rpc.request("nope")).rejects.toThrow(CodexRpcError);
    await expect(rpc.request("nope")).rejects.toThrow(/no such method/);
  });

  it("ignores a response to an id it never sent", async () => {
    const notifications: string[] = [];
    const rpc = connect(
      child(`
process.stdout.write(JSON.stringify({ id: 999, result: {} }) + "\\n");
${ECHO}
`),
      { onNotification: (method) => notifications.push(method) }
    );

    await expect(rpc.request("alive")).resolves.toEqual({ echoed: "alive" });
    expect(notifications).toEqual([]);
  });
});

describe("child failure", () => {
  it("rejects in-flight requests when the child exits, quoting its stderr", async () => {
    const rpc = connect(
      child(`
process.stderr.write("codex: boom\\n");
setTimeout(() => process.exit(2), 20);
`)
    );

    await expect(rpc.request("anything")).rejects.toThrow(/exited \(2\).*boom/s);
  });

  it("reports a close exactly once, even when close() also runs", async () => {
    const closes: string[] = [];
    const rpc = connect(child("setTimeout(() => process.exit(0), 10);"), {
      onClose: (error) => closes.push(error.message),
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await rpc.close();

    expect(closes).toHaveLength(1);
  });

  it("tears down on invalid JSON rather than parsing forever", async () => {
    const rpc = connect(
      child('process.stdout.write("{ not json\\n"); setInterval(() => {}, 1000);')
    );

    await expect(rpc.request("anything")).rejects.toThrow(/invalid JSON/);
  });

  it("rejects a request made after the child is gone", async () => {
    const rpc = connect(child("process.exit(0);"));

    await new Promise((resolve) => setTimeout(resolve, 200));

    await expect(rpc.request("late")).rejects.toThrow(/exited/);
  });
});

describe("close", () => {
  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    let ready: () => void = () => {};
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const rpc = connect(
      child(`
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ method: "ready" }) + "\\n");
setInterval(() => {}, 1000);
`),
      { onNotification: () => ready() }
    );
    // Wait for the handler to actually be installed: a SIGTERM that lands while the child is still
    // booting is handled by Node's default disposition, which would kill it and prove nothing.
    await isReady;

    const started = Date.now();
    await rpc.close();

    // The grace period is 2s; without escalation this would hang until the test timed out.
    expect(rpc.process.killed).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(1_000);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 15_000);

  it("is idempotent", async () => {
    const rpc = connect(child(ECHO));

    await rpc.close();
    await expect(rpc.close()).resolves.toBeUndefined();
  });

  it("stays bounded when a queued write can never be flushed", async () => {
    // Teardown gives pending writes a chance to leave, but a child that stopped reading its stdin
    // must not be able to hold the turn open by simply never draining the pipe.
    const rpc = connect(child("process.stdin.pause(); setInterval(() => {}, 1000);"));
    void rpc.notify("last/word", { value: "x".repeat(2_000_000) }).catch(() => undefined);

    const started = Date.now();
    await rpc.close();

    expect(Date.now() - started).toBeLessThan(6_000);
  }, 15_000);
});

describe("server-initiated requests", () => {
  it("answers them, and reports a handler failure as a JSON-RPC error", async () => {
    const replies = join(workDir, "replies.txt");
    connect(
      child(`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ id: 7, method: "item/tool/call", params: {} }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(${JSON.stringify(replies)}, line + "\\n");
});
`),
      { onRequest: async () => Promise.reject(new Error("broker refused")) }
    );

    await vi.waitFor(async () => {
      const { readFileSync } = await import("node:fs");
      const written = readFileSync(replies, "utf8");
      expect(JSON.parse(written.trim())).toMatchObject({
        id: 7,
        error: { code: -32000, message: "broker refused" },
      });
    });
  });
});
