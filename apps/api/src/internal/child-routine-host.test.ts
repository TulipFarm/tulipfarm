import type {
  ChildLink,
  ChildLinkAncestry,
  ChildLinkStore,
  ChildResumeGrant,
  RegisteredWait,
  RegisterWaitInput,
} from "@tulipfarm/run-kernel";
import { CHILD_COMPLETION_SCHEMA_REF, routineWaitId } from "@tulipfarm/run-kernel";
import type { PersistedWait } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ChildRoutineDeniedError,
  InternalChildRoutineHost,
  type StartChildRoutineInput,
} from "./child-routine-host";
import type { HostedRunReader } from "./turn-host";

const BUSINESS = "biz";
const PARENT = "run-parent";
const NOW = new Date("2026-08-02T00:00:00.000Z");

class FakeLinks implements ChildLinkStore, ChildLinkAncestry {
  readonly rows: ChildLink[] = [];

  async link(input: {
    businessId: string;
    parentRunId: string;
    childRunId: string;
    authority: ChildLink["authority"];
    authorityBinding?: ChildLink["authorityBinding"];
    resume?: ChildResumeGrant;
    callId?: string;
    detachedAt?: string;
    createdAt: string;
  }): Promise<ChildLink> {
    const existing = this.rows.find(
      (row) => row.parentRunId === input.parentRunId && row.childRunId === input.childRunId
    );
    if (existing) return existing;
    const row: ChildLink = {
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      authority: input.authority,
      authorityBinding: input.authorityBinding ?? "delegated",
      resume: input.resume ?? null,
      callId: input.callId ?? null,
      detachedAt: input.detachedAt ?? null,
      createdAt: input.createdAt,
    };
    this.rows.push(row);
    return row;
  }

  async detach(
    _businessId: string,
    parentRunId: string,
    childRunId: string,
    detachedAt: string
  ): Promise<boolean> {
    const index = this.rows.findIndex(
      (row) => row.parentRunId === parentRunId && row.childRunId === childRunId
    );
    const row = this.rows[index];
    if (row === undefined || row.detachedAt !== null) return false;
    this.rows[index] = { ...row, detachedAt };
    return true;
  }

  async listChildren(_businessId: string, parentRunId: string): Promise<readonly ChildLink[]> {
    return this.rows.filter((row) => row.parentRunId === parentRunId);
  }

  async parentLink(_businessId: string, childRunId: string): Promise<ChildLink | null> {
    return this.rows.find((row) => row.childRunId === childRunId) ?? null;
  }

  async callLink(
    _businessId: string,
    parentRunId: string,
    callId: string
  ): Promise<ChildLink | null> {
    return (
      this.rows.find((row) => row.parentRunId === parentRunId && row.callId === callId) ?? null
    );
  }
}

class FakeWaits {
  readonly registered: RegisterWaitInput[] = [];
  readonly rows = new Map<string, PersistedWait>();

  async register(input: RegisterWaitInput): Promise<RegisteredWait> {
    this.registered.push(input);
    this.rows.set(input.id, { id: input.id, status: "pending" } as PersistedWait);
    return { wait: { id: input.id } as PersistedWait, token: `token-${input.id}` };
  }

  async find(_businessId: string, waitId: string): Promise<PersistedWait | null> {
    return this.rows.get(waitId) ?? null;
  }

  expire(waitId: string): void {
    const row = this.rows.get(waitId);
    if (row === undefined) throw new Error(`no wait ${waitId}`);
    this.rows.set(waitId, { ...row, status: "timed_out" });
  }
}

type FakeRun = { status: string; source: string };

class FakeRuns implements HostedRunReader {
  readonly rows = new Map<string, FakeRun>([[PARENT, { status: "running", source: "routine" }]]);

  async find(_businessId: string, runId: string) {
    const row = this.rows.get(runId);
    if (row === undefined) return null;
    return {
      status: row.status,
      source: row.source,
      bundle: { digest: "sha256:x", routineId: "routine-1" },
      identity: { effectiveSubject: { kind: "user", id: "operator-1" } },
    };
  }
}

function request(overrides: Partial<StartChildRoutineInput> = {}): StartChildRoutineInput {
  return {
    stateKey: "CallReindex",
    stateName: "CallReindex",
    routineRef: { name: "reindex-knowledge", version: "3" },
    mode: "wait",
    input: { region: "west" },
    deadlineMs: 60_000,
    ...overrides,
  };
}

describe("InternalChildRoutineHost", () => {
  let links: FakeLinks;
  let waits: FakeWaits;
  let runs: FakeRuns;
  let started: { slug: string; inputs: unknown; idempotencyKey: string; identity: unknown }[];
  let host: InternalChildRoutineHost;

  function compose(options: { maxDepth?: number } = {}): InternalChildRoutineHost {
    return new InternalChildRoutineHost({
      runs,
      links,
      ancestry: links,
      waits,
      start: async (input) => {
        started.push(input);
        const runId = `run-child-${started.length}`;
        runs.rows.set(runId, { status: "running", source: "routine" });
        return { runId };
      },
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      now: () => NOW,
    });
  }

  beforeEach(() => {
    links = new FakeLinks();
    waits = new FakeWaits();
    runs = new FakeRuns();
    started = [];
    host = compose();
  });

  it("mints the child as the caller's own subject, not as a scheduler name", async () => {
    const record = await host.start(BUSINESS, PARENT, request());

    expect(record).toEqual({
      childRunId: "run-child-1",
      status: "pending",
      waitId: routineWaitId(PARENT, "CallReindex"),
    });
    expect(started[0]).toEqual({
      slug: "reindex-knowledge",
      inputs: { region: "west" },
      identity: { kind: "user", id: "operator-1" },
      idempotencyKey: `child_routine:${PARENT}:CallReindex`,
    });
  });

  it("registers the caller's wait on the ref the child's completion actually delivers", async () => {
    await host.start(BUSINESS, PARENT, request());

    expect(waits.registered[0]).toMatchObject({
      id: routineWaitId(PARENT, "CallReindex"),
      kind: "child_run",
      schemaRef: CHILD_COMPLETION_SCHEMA_REF,
      allowedPrincipals: ["run:run-child-1"],
      deadlineAt: "2026-08-02T00:01:00.000Z",
    });
  });

  it("records lineage only, so the child keeps the authority it was published with", async () => {
    await host.start(BUSINESS, PARENT, request());

    expect(links.rows[0]).toMatchObject({
      authorityBinding: "lineage",
      authority: { tools: [], classifications: [], limits: {} },
      callId: "CallReindex",
    });
  });

  it("adopts the child it already started rather than running the callee twice", async () => {
    const first = await host.start(BUSINESS, PARENT, request());
    const second = await host.start(BUSINESS, PARENT, request());

    expect(second.childRunId).toBe(first.childRunId);
    expect(started).toHaveLength(1);
    expect(waits.registered).toHaveLength(1);
  });

  it("closes a detached child's link so the caller is never resumed by it", async () => {
    const record = await host.start(
      BUSINESS,
      PARENT,
      request({ mode: "detach", deadlineMs: undefined })
    );

    expect(record).toEqual({ childRunId: "run-child-1", status: "pending", waitId: null });
    expect(waits.registered).toHaveLength(0);
    expect(links.rows[0]).toMatchObject({ detachedAt: NOW.toISOString(), resume: null });
  });

  it("answers a child that settled before its link was durable", async () => {
    host = new InternalChildRoutineHost({
      runs,
      links,
      ancestry: links,
      waits,
      start: async () => {
        const runId = "run-child-fast";
        runs.rows.set(runId, { status: "succeeded", source: "routine" });
        return { runId };
      },
      now: () => NOW,
    });

    const record = await host.start(BUSINESS, PARENT, request());

    expect(record).toEqual({ childRunId: "run-child-fast", status: "succeeded", waitId: null });
  });

  it("reports a child that outlived the caller's deadline as expired, not pending", async () => {
    await host.start(BUSINESS, PARENT, request());
    waits.expire(routineWaitId(PARENT, "CallReindex"));

    await expect(host.find(BUSINESS, PARENT, "CallReindex")).resolves.toEqual({
      childRunId: "run-child-1",
      status: "expired",
      waitId: routineWaitId(PARENT, "CallReindex"),
    });
  });

  it("prefers the child's own terminal status over its caller's expired wait", async () => {
    await host.start(BUSINESS, PARENT, request());
    waits.expire(routineWaitId(PARENT, "CallReindex"));
    runs.rows.set("run-child-1", { status: "failed", source: "routine" });

    await expect(host.find(BUSINESS, PARENT, "CallReindex")).resolves.toMatchObject({
      status: "failed",
      waitId: null,
    });
  });

  it("reports nothing for a State occurrence that called no child", async () => {
    await expect(host.find(BUSINESS, PARENT, "CallReindex")).resolves.toBeUndefined();
  });

  it("refuses a chain that would pass the depth ceiling", async () => {
    host = compose({ maxDepth: 1 });
    await links.link({
      businessId: BUSINESS,
      parentRunId: "run-root",
      childRunId: PARENT,
      authority: { tools: [], classifications: [], limits: {} },
      authorityBinding: "lineage",
      createdAt: NOW.toISOString(),
    });

    await expect(host.start(BUSINESS, PARENT, request())).rejects.toMatchObject({
      code: "depth_limit_exceeded",
    });
    expect(started).toHaveLength(0);
  });

  it("refuses a `wait` call with no deadline before anything is minted", async () => {
    await expect(
      host.start(BUSINESS, PARENT, request({ deadlineMs: undefined }))
    ).rejects.toBeInstanceOf(ChildRoutineDeniedError);
    expect(started).toHaveLength(0);
    expect(links.rows).toHaveLength(0);
  });

  it("refuses a caller no executor holds", async () => {
    runs.rows.set(PARENT, { status: "waiting", source: "routine" });

    await expect(host.start(BUSINESS, PARENT, request())).rejects.toMatchObject({
      code: "run_not_running",
    });
  });

  it("refuses a caller that is not a Routine", async () => {
    runs.rows.set(PARENT, { status: "running", source: "chat" });

    await expect(host.start(BUSINESS, PARENT, request())).rejects.toMatchObject({
      code: "not_a_routine",
    });
  });

  it("refuses a caller that does not exist", async () => {
    await expect(host.start(BUSINESS, "run-ghost", request())).rejects.toMatchObject({
      code: "run_not_found",
    });
  });
});
