import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../db";
import { makeMigratedPglite } from "../test/pglite";
import {
  type SlackCommandResponseSecrets,
  SlackCommandResponseService,
  SlackCommandResponseStore,
} from "./slack-command-response";

describe("SlackCommandResponseService", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeMigratedPglite();
  });

  afterEach(async () => {
    await db.close();
  });

  it("keeps response URLs out of the job row and retries the same durable delivery", async () => {
    let now = new Date("2026-09-07T10:00:00.000Z");
    const values = new Map<string, string>();
    const secrets: SlackCommandResponseSecrets = {
      set: vi.fn(async (key, value) => {
        values.set(key, value);
      }),
      get: vi.fn(async (key) => {
        const value = values.get(key);
        if (value === undefined) throw new Error("secret missing");
        return value;
      }),
      delete: vi.fn(async (key) => {
        values.delete(key);
      }),
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const service = new SlackCommandResponseService({
      businessId: "business-1",
      store: new SlackCommandResponseStore(db as unknown as Queryable, () => now),
      secrets,
      fetch,
    });
    const responseUrl = "https://hooks.slack.com/commands/1/2/3";
    const input = {
      idempotencyKey: "slack-command-response:T1:trigger-1",
      responseUrl,
      response: "starting" as const,
    };

    await expect(service.reserve(input)).resolves.toBe("reserved");
    const rows = await db.query<{ persisted: string }>(
      "SELECT row_to_json(slack_command_response_jobs)::text AS persisted FROM slack_command_response_jobs"
    );
    expect(rows.rows[0]?.persisted).not.toContain(responseUrl);

    await expect(service.process("recovery")).resolves.toEqual({ attempted: 0, delivered: 0 });
    await expect(service.process("worker-1", input.idempotencyKey)).resolves.toEqual({
      attempted: 1,
      delivered: 0,
    });
    now = new Date("2026-09-07T10:00:02.000Z");
    await expect(service.process("worker-1", input.idempotencyKey)).resolves.toEqual({
      attempted: 1,
      delivered: 1,
    });
    await expect(service.reserve(input)).resolves.toBe("duplicate");
    await expect(service.process("worker-1")).resolves.toEqual({ attempted: 0, delivered: 0 });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      responseUrl,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          response_type: "ephemeral",
          text: "Starting your TulipFarm request…",
        }),
      })
    );
    expect(secrets.set).toHaveBeenCalledTimes(1);
    expect(secrets.delete).toHaveBeenCalledTimes(1);
  });

  it("recovers after the acknowledgement window without duplicating delivery on replay", async () => {
    let now = new Date("2026-09-07T10:00:00.000Z");
    const values = new Map<string, string>();
    const secrets: SlackCommandResponseSecrets = {
      set: vi.fn(async (key, value) => {
        values.set(key, value);
      }),
      get: vi.fn(async (key) => {
        const value = values.get(key);
        if (value === undefined) throw new Error("secret missing");
        return value;
      }),
      delete: vi.fn(async (key) => {
        values.delete(key);
      }),
    };
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const service = new SlackCommandResponseService({
      businessId: "business-1",
      store: new SlackCommandResponseStore(db as unknown as Queryable, () => now),
      secrets,
      fetch,
    });
    const input = {
      idempotencyKey: "slack-command-response:T1:trigger-2",
      responseUrl: "https://hooks.slack.com/commands/1/2/4",
      response: "starting" as const,
    };

    await expect(service.reserve(input)).resolves.toBe("reserved");
    await expect(service.process("recovery")).resolves.toEqual({ attempted: 0, delivered: 0 });

    now = new Date("2026-09-07T10:00:03.000Z");
    await expect(service.process("recovery")).resolves.toEqual({ attempted: 1, delivered: 1 });
    await expect(service.reserve(input)).resolves.toBe("duplicate");
    await expect(service.process("post-ack", input.idempotencyKey)).resolves.toEqual({
      attempted: 0,
      delivered: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects non-Slack response URLs before persistence", async () => {
    const secrets = {
      set: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    } as unknown as SlackCommandResponseSecrets;
    const service = new SlackCommandResponseService({
      businessId: "business-1",
      store: new SlackCommandResponseStore(db as unknown as Queryable),
      secrets,
    });

    await expect(
      service.reserve({
        idempotencyKey: "command-1",
        responseUrl: "https://example.com/commands/1",
        response: "starting",
      })
    ).rejects.toThrow("slack_command_response_url_invalid");
    expect(secrets.set).not.toHaveBeenCalled();
  });
});
