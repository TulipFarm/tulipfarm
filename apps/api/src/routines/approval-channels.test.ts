import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalsRepo } from "../approvals/runtime-repo";
import type { ToolRegistry } from "../broker/tool-adapter";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import type { ToolDef } from "../tools/types";
import { makeApprovalRequester } from "./approval-channels";
import type { RoutineRunRow } from "./run-store-adapter";

function makeRun(): RoutineRunRow {
  return {
    id: randomUUID(),
    routineSlug: "expense-report",
  } as RoutineRunRow;
}

function makeToolRegistry(tools: ToolDef[]): ToolRegistry {
  return { getAll: () => tools } as unknown as ToolRegistry;
}

describe("makeApprovalRequester (AC-V1-003)", () => {
  let db: PGlite;
  let approvals: ApprovalsRepo;
  const log = { warn: vi.fn() };

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db);
    approvals = new ApprovalsRepo(db);
    log.warn.mockClear();
  });

  afterEach(async () => {
    await db.close();
  });

  it("inserts a pending routine_state row for the ui channel", async () => {
    const requester = makeApprovalRequester({ approvals, log });
    const run = makeRun();
    const approvalId = await requester(run, {
      stateName: "Gate",
      channels: ["ui"],
      summary: { amount: 900 },
    });

    const row = await approvals.findById(approvalId);
    expect(row?.kind).toBe("routine_state");
    expect(row?.status).toBe("pending");
    expect(row?.payload).toMatchObject({
      routineSlug: "expense-report",
      runId: run.id,
      stateName: "Gate",
      summary: { amount: 900 },
    });
  });

  it("delivers to slack via an installed integration send tool", async () => {
    const execute = vi.fn(async () => ({ success: true as const, data: { ok: true } }));
    const slackTool = {
      name: "slack_send_message",
      tier: "integration",
      mutating: true,
      description: "",
      inputSchema: {},
      execute,
    } as unknown as ToolDef;
    const requester = makeApprovalRequester({
      approvals,
      toolRegistry: makeToolRegistry([slackTool]),
      publicUrl: "https://tulip.example",
      log,
    });

    await requester(makeRun(), { stateName: "Gate", channels: ["ui", "slack"], summary: {} });
    expect(execute).toHaveBeenCalledOnce();
    const [args] = execute.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(String(args.text)).toContain("expense-report");
    expect(String(args.text)).toContain("https://tulip.example/approvals");
  });

  it("falls back to ui with a warning when slack is absent (spec-legal)", async () => {
    const requester = makeApprovalRequester({
      approvals,
      toolRegistry: makeToolRegistry([]),
      log,
    });
    const approvalId = await requester(makeRun(), {
      stateName: "Gate",
      channels: ["slack"],
      summary: {},
    });
    expect((await approvals.findById(approvalId))?.status).toBe("pending");
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("no Slack send tool")
    );
  });

  it("email/sms declarations fall back to ui with a warning (AC-V1-003)", async () => {
    const requester = makeApprovalRequester({ approvals, log });
    const approvalId = await requester(makeRun(), {
      stateName: "Gate",
      channels: ["email", "sms"],
      summary: {},
    });
    expect((await approvals.findById(approvalId))?.status).toBe("pending");
    const warnings = log.warn.mock.calls.map((c) => String(c[1]));
    expect(warnings.some((w) => w.includes('"email" unavailable'))).toBe(true);
    expect(warnings.some((w) => w.includes('"sms" unavailable'))).toBe(true);
  });

  it("a failing slack delivery never blocks the approval", async () => {
    const slackTool = {
      name: "slack_post",
      tier: "integration",
      mutating: true,
      description: "",
      inputSchema: {},
      execute: vi.fn(async () => {
        throw new Error("slack down");
      }),
    } as unknown as ToolDef;
    const requester = makeApprovalRequester({
      approvals,
      toolRegistry: makeToolRegistry([slackTool]),
      log,
    });
    const approvalId = await requester(makeRun(), {
      stateName: "Gate",
      channels: ["slack"],
      summary: {},
    });
    expect((await approvals.findById(approvalId))?.status).toBe("pending");
  });
});
