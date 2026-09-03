import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import {
  CHANNEL_MENTIONED_THREAD_STORAGE_STATEMENTS,
  ChannelMentionedThreadStore,
} from "./channel-mentioned-thread-store";

const BUSINESS_ID = "business-1";

describe("ChannelMentionedThreadStore", () => {
  let database: PGlite;
  let store: ChannelMentionedThreadStore;
  let now: string;

  beforeAll(async () => {
    database = new PGlite();
    for (const statement of CHANNEL_MENTIONED_THREAD_STORAGE_STATEMENTS) {
      await database.exec(statement);
    }
    store = new ChannelMentionedThreadStore(transactionPort(database), () => now);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE channel_mentioned_threads");
    now = "2026-07-26T10:00:00.000Z";
  });

  it("is not mentioned before a mark", async () => {
    expect(
      await store.isMentioned({
        businessId: BUSINESS_ID,
        provider: "slack",
        channelId: "C1",
        threadId: "1720000000.000100",
      })
    ).toBe(false);
  });

  it("recognizes a thread as mentioned after mark, and mark is idempotent", async () => {
    const thread = {
      businessId: BUSINESS_ID,
      provider: "slack",
      channelId: "C1",
      threadId: "1720000000.000100",
    };

    await store.mark(thread);
    await store.mark(thread);

    expect(await store.isMentioned(thread)).toBe(true);
  });

  it("scopes mention state by business, provider, and channel, not just thread id", async () => {
    const threadId = "1720000000.000100";
    await store.mark({ businessId: BUSINESS_ID, provider: "slack", channelId: "C1", threadId });

    expect(
      await store.isMentioned({
        businessId: BUSINESS_ID,
        provider: "slack",
        channelId: "C2",
        threadId,
      })
    ).toBe(false);
    expect(
      await store.isMentioned({
        businessId: BUSINESS_ID,
        provider: "telegram",
        channelId: "C1",
        threadId,
      })
    ).toBe(false);
    expect(
      await store.isMentioned({
        businessId: "business-2",
        provider: "slack",
        channelId: "C1",
        threadId,
      })
    ).toBe(false);
  });
});
