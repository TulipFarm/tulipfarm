import { describe, expect, it, vi } from "vitest";
import { SlackHttpKnowledgeApi } from "./slack-http";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SlackHttpKnowledgeApi", () => {
  it("maps conversations.list channels to their public/private/dm/group_dm kind", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        channels: [
          { id: "C1", name: "general", is_private: false, is_archived: false },
          { id: "C2", name: "secrets", is_private: true, is_archived: false },
          { id: "D1", is_im: true, user: "U9", is_archived: false },
          { id: "G1", is_mpim: true, name: "mpdm-a-b-1", is_archived: true },
        ],
      })
    );
    const api = new SlackHttpKnowledgeApi({ token: "xoxb-test", teamId: "T1", fetch: fetchImpl });

    const channels = await api.listChannels();

    expect(channels).toEqual([
      { id: "C1", name: "general", kind: "public", teamId: "T1", archived: false },
      { id: "C2", name: "secrets", kind: "private", teamId: "T1", archived: false },
      { id: "D1", name: "D1", kind: "dm", teamId: "T1", archived: false },
      { id: "G1", name: "mpdm-a-b-1", kind: "group_dm", teamId: "T1", archived: true },
    ]);
  });

  it("paginates conversations.members across cursors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, members: ["U1", "U2"], response_metadata: { next_cursor: "p2" } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, members: ["U3"], response_metadata: { next_cursor: "" } })
      );
    const api = new SlackHttpKnowledgeApi({ token: "xoxb-test", teamId: "T1", fetch: fetchImpl });

    const members = await api.listMembers("C1");

    expect(members).toEqual(["U1", "U2", "U3"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns undefined for membership when the bot cannot see the channel", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: "not_in_channel" }));
    const api = new SlackHttpKnowledgeApi({ token: "xoxb-test", teamId: "T1", fetch: fetchImpl });

    await expect(api.listMembers("C1")).resolves.toBeUndefined();
  });

  it("rethrows unexpected Slack errors from listMembers rather than masking them as unreadable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: "internal_error" }));
    const api = new SlackHttpKnowledgeApi({ token: "xoxb-test", teamId: "T1", fetch: fetchImpl });

    await expect(api.listMembers("C1")).rejects.toThrow("slack_api_error:internal_error");
  });

  it("returns real user messages in ascending ts order, dropping system subtypes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        has_more: false,
        messages: [
          { ts: "3.0", user: "U1", text: "third" },
          { ts: "1.0", user: "U1", text: "first" },
          { ts: "2.0", text: "no user, e.g. a bot message" },
          { ts: "1.5", user: "U2", text: "joined", subtype: "channel_join" },
          { ts: "2.5", user: "U2", text: "second", thread_ts: "1.0", edited: { ts: "2.6" } },
        ],
      })
    );
    const api = new SlackHttpKnowledgeApi({ token: "xoxb-test", teamId: "T1", fetch: fetchImpl });

    const { messages } = await api.listMessages({ channelId: "C1", pageLimit: 10 });

    expect(messages).toEqual([
      { channelId: "C1", ts: "1.0", userExternalId: "U1", text: "first" },
      {
        channelId: "C1",
        ts: "2.5",
        userExternalId: "U2",
        text: "second",
        threadTs: "1.0",
        editedTs: "2.6",
      },
      { channelId: "C1", ts: "3.0", userExternalId: "U1", text: "third" },
    ]);
  });

  it("caps returned messages at pageLimit, keeping the oldest first", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        has_more: false,
        messages: [
          { ts: "3.0", user: "U1", text: "c" },
          { ts: "1.0", user: "U1", text: "a" },
          { ts: "2.0", user: "U1", text: "b" },
        ],
      })
    );
    const api = new SlackHttpKnowledgeApi({ token: "xoxb-test", teamId: "T1", fetch: fetchImpl });

    const { messages } = await api.listMessages({ channelId: "C1", pageLimit: 2 });

    expect(messages.map((m) => m.ts)).toEqual(["1.0", "2.0"]);
  });

  it("stops gracefully after the page bound instead of throwing, so the caller can checkpoint and resume", async () => {
    const page = (ts: string, hasMore: boolean, nextCursor?: string) =>
      jsonResponse({
        ok: true,
        has_more: hasMore,
        ...(nextCursor ? { response_metadata: { next_cursor: nextCursor } } : {}),
        messages: [{ ts, user: "U1", text: `msg-${ts}` }],
      });
    const fetchImpl = vi.fn().mockImplementation(() => page("1.0", true, "next"));
    const api = new SlackHttpKnowledgeApi({ token: "xoxb-test", teamId: "T1", fetch: fetchImpl });

    const { messages } = await api.listMessages({ channelId: "C1", pageLimit: 200 });

    // Bounded at 25 pages; never throws, always resolves with whatever it collected.
    expect(fetchImpl).toHaveBeenCalledTimes(25);
    expect(messages.length).toBeGreaterThan(0);
  });

  it("sends the bot token as a bearer header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, channels: [] }));
    const api = new SlackHttpKnowledgeApi({ token: "xoxb-secret", teamId: "T1", fetch: fetchImpl });

    await api.listChannels();

    const [, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-secret");
  });
});
