import type {
  ChildLink,
  ChildLinkAncestry,
  ChildLinkStore,
  ChildResumeGrant,
  EventTriggerDispatch,
} from "@tulipfarm/run-kernel";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EmitDeniedError,
  type EmitEventInput,
  emissionEventId,
  InternalEmitHost,
  type InternalEventDispatcher,
} from "./emit-host";
import type { HostedRunReader } from "./turn-host";

const BUSINESS = "biz";
const EMITTER = "run-emitter";
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

type FakeRun = { status: string; source: string };

class FakeRuns implements HostedRunReader {
  readonly rows = new Map<string, FakeRun>([[EMITTER, { status: "running", source: "routine" }]]);

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

function request(overrides: Partial<EmitEventInput> = {}): EmitEventInput {
  return {
    stateKey: "AnnounceTriaged",
    eventType: "ticket.triaged",
    eventVersion: 1,
    data: { ticketId: "t-1" },
    ...overrides,
  };
}

describe("InternalEmitHost", () => {
  let links: FakeLinks;
  let runs: FakeRuns;
  let announced: Parameters<InternalEventDispatcher>[0][];
  let outcome: EventTriggerDispatch;

  function compose(options: { maxDepth?: number } = {}): InternalEmitHost {
    return new InternalEmitHost({
      runs,
      links,
      ancestry: links,
      dispatch: async (event) => {
        announced.push(event);
        if (outcome.kind === "started") {
          runs.rows.set(outcome.runId, { status: "running", source: "routine" });
        }
        return outcome;
      },
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      now: () => NOW,
    });
  }

  beforeEach(() => {
    links = new FakeLinks();
    runs = new FakeRuns();
    announced = [];
    outcome = {
      kind: "started",
      triggerSlug: "on-ticket-triaged",
      runId: "run-started",
      outcome: "started",
    };
  });

  it("announces the event and reports the Run a Trigger started", async () => {
    const record = await compose().emit(BUSINESS, EMITTER, request());

    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({
      eventType: "ticket.triaged",
      eventVersion: 1,
      data: { ticketId: "t-1" },
      emitterRunId: EMITTER,
      principal: { kind: "user", id: "operator-1" },
    });
    expect(record).toEqual({
      eventId: emissionEventId(EMITTER, "AnnounceTriaged"),
      outcome: "started",
      triggerSlug: "on-ticket-triaged",
      runId: "run-started",
    });
  });

  it("links the started Run to the emitter and detaches it at once", async () => {
    await compose().emit(BUSINESS, EMITTER, request());

    expect(links.rows).toHaveLength(1);
    expect(links.rows[0]).toMatchObject({
      parentRunId: EMITTER,
      childRunId: "run-started",
      authorityBinding: "lineage",
      callId: "AnnounceTriaged",
      detachedAt: NOW.toISOString(),
    });
  });

  it("uses an event id derived from the emitting State occurrence", async () => {
    await compose().emit(BUSINESS, EMITTER, request());
    expect(announced[0]?.eventId).toBe(`emit:${EMITTER}:AnnounceTriaged`);
  });

  it("adopts the Run this State occurrence already started instead of announcing twice", async () => {
    const host = compose();
    await host.emit(BUSINESS, EMITTER, request());
    const replayed = await host.emit(BUSINESS, EMITTER, request());

    expect(announced).toHaveLength(1);
    expect(replayed).toEqual({
      eventId: emissionEventId(EMITTER, "AnnounceTriaged"),
      outcome: "started",
      runId: "run-started",
    });
  });

  it("succeeds, and links nothing, when no Trigger listens", async () => {
    outcome = { kind: "no_match" };
    const record = await compose().emit(BUSINESS, EMITTER, request());

    expect(record).toEqual({
      eventId: emissionEventId(EMITTER, "AnnounceTriaged"),
      outcome: "no_match",
    });
    expect(links.rows).toHaveLength(0);
  });

  it("succeeds, and links nothing, when two Triggers claim the event", async () => {
    outcome = { kind: "ambiguous", candidates: ["a", "b"] };
    const record = await compose().emit(BUSINESS, EMITTER, request());

    expect(record.outcome).toBe("ambiguous");
    expect(links.rows).toHaveLength(0);
  });

  it("reports a deduplicated Run as `duplicate`", async () => {
    outcome = { kind: "started", triggerSlug: "t", runId: "run-started", outcome: "duplicate" };
    const record = await compose().emit(BUSINESS, EMITTER, request());
    expect(record.outcome).toBe("duplicate");
  });

  it("refuses to announce an event type this deployment mints about its own Records", async () => {
    await expect(
      compose().emit(BUSINESS, EMITTER, request({ eventType: "resource.created" }))
    ).rejects.toMatchObject({ code: "reserved_event_type" });
    expect(announced).toHaveLength(0);
  });

  it("refuses to extend a chain that has reached its depth bound", async () => {
    // Two ancestors already reach the emitter, so a third link would exceed a bound of two.
    await links.link({
      businessId: BUSINESS,
      parentRunId: "run-a",
      childRunId: "run-b",
      authority: { tools: [], classifications: [], limits: {} },
      createdAt: NOW.toISOString(),
    });
    await links.link({
      businessId: BUSINESS,
      parentRunId: "run-b",
      childRunId: EMITTER,
      authority: { tools: [], classifications: [], limits: {} },
      createdAt: NOW.toISOString(),
    });

    await expect(
      compose({ maxDepth: 2 }).emit(BUSINESS, EMITTER, request())
    ).rejects.toBeInstanceOf(EmitDeniedError);
    expect(announced).toHaveLength(0);
  });

  it("allows an emission that stays inside the depth bound", async () => {
    await links.link({
      businessId: BUSINESS,
      parentRunId: "run-a",
      childRunId: EMITTER,
      authority: { tools: [], classifications: [], limits: {} },
      createdAt: NOW.toISOString(),
    });

    await expect(
      compose({ maxDepth: 2 }).emit(BUSINESS, EMITTER, request())
    ).resolves.toMatchObject({ outcome: "started" });
  });

  it("refuses a Run that does not exist", async () => {
    await expect(compose().emit(BUSINESS, "run-missing", request())).rejects.toMatchObject({
      code: "run_not_found",
    });
  });

  it("refuses a Run no executor holds", async () => {
    runs.rows.set(EMITTER, { status: "waiting", source: "routine" });
    await expect(compose().emit(BUSINESS, EMITTER, request())).rejects.toMatchObject({
      code: "run_not_running",
    });
  });

  it("refuses a Run that is not a Routine", async () => {
    runs.rows.set(EMITTER, { status: "running", source: "chat" });
    await expect(compose().emit(BUSINESS, EMITTER, request())).rejects.toMatchObject({
      code: "not_a_routine",
    });
  });
});
