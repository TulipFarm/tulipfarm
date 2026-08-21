import type { IntegrationHttpRequest } from "@tulipfarm/integrations";
import type { SecretsService } from "@tulipfarm/secrets";
import { MemoryEffectStore } from "@tulipfarm/tool-broker";
import type { RequestContext } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import { buildGoogleTooling } from "./compose";
import { buildGoogleTools } from "./tools";

const BUSINESS_ID = "biz-google";
const ACCESS_TOKEN = "ya29.fake-access-token";

function fakeSecretsService(): () => Promise<SecretsService> {
  return async () =>
    ({
      get: async (key: string) => {
        if (key.includes("GOOGLE_ACCESS_TOKEN")) return ACCESS_TOKEN;
        throw new Error(`no secret ${key}`);
      },
      // biome-ignore lint/suspicious/noExplicitAny: only `get` is exercised
    }) as any;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return { userId: "user-1", runId: "run-1", toolCallId: "call-1", ...overrides };
}

function toolsWith(http: {
  send: (request: IntegrationHttpRequest, credential?: string) => unknown;
}) {
  // Every Google service resolves to the same fake port; the fake branches on request.path.
  const tooling = buildGoogleTooling({
    secrets: fakeSecretsService(),
    http: (() => http) as never,
  });
  return buildGoogleTools(BUSINESS_ID, { ...tooling, effects: new MemoryEffectStore() });
}

describe("buildGoogleTools", () => {
  it("derives egress destinations and mutating flags from the published contracts", () => {
    const tools = toolsWith({ async send() {} });
    const draft = tools.find((tool) => tool.name === "gmail_draft");
    const search = tools.find((tool) => tool.name === "gmail_search");
    expect(draft?.mutating).toBe(true);
    expect(search?.mutating).toBe(false);
    expect(draft?.definition?.authorization.allowedDestinations).toEqual(["google"]);
  });

  it("searches Gmail and enriches each hit with its headers and snippet", async () => {
    const http = {
      async send(request: IntegrationHttpRequest, credential?: string) {
        expect(credential).toBe(ACCESS_TOKEN);
        if (request.path === "/users/me/messages") {
          expect(request.query?.q).toBe("is:unread");
          return { status: 200, headers: {}, body: { messages: [{ id: "m1", threadId: "t1" }] } };
        }
        if (request.path === "/users/me/messages/m1") {
          return {
            status: 200,
            headers: {},
            body: {
              id: "m1",
              threadId: "t1",
              snippet: "quick hello",
              payload: {
                headers: [
                  { name: "From", value: "alice@acme.com" },
                  { name: "Subject", value: "Hi" },
                ],
              },
            },
          };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "gmail_search");
    if (tool === undefined) throw new Error("gmail_search not registered");

    const result = await tool.execute({ query: "is:unread" }, context());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        messages: [
          {
            id: "m1",
            threadId: "t1",
            from: "alice@acme.com",
            subject: "Hi",
            snippet: "quick hello",
          },
        ],
      });
    }
  });

  it("reads a message and decodes its plain-text body", async () => {
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/users/me/messages/m9") {
          return {
            status: 200,
            headers: {},
            body: {
              id: "m9",
              threadId: "t9",
              snippet: "meeting notes",
              payload: {
                mimeType: "multipart/alternative",
                headers: [
                  { name: "From", value: "bob@acme.com" },
                  { name: "To", value: "me@acme.com" },
                  { name: "Subject", value: "Notes" },
                ],
                parts: [
                  { mimeType: "text/plain", body: { data: base64Url("Line one\nLine two") } },
                  { mimeType: "text/html", body: { data: base64Url("<p>ignored</p>") } },
                ],
              },
            },
          };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "gmail_read");
    if (tool === undefined) throw new Error("gmail_read not registered");

    const result = await tool.execute({ messageId: "m9" }, context());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        id: "m9",
        threadId: "t9",
        from: "bob@acme.com",
        subject: "Notes",
        body: "Line one\nLine two",
      });
    }
  });

  it("creates a draft with a base64url MIME payload and returns its ids", async () => {
    const sent: unknown[] = [];
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.method === "POST" && request.path === "/users/me/drafts") {
          sent.push(request.body);
          return {
            status: 200,
            headers: {},
            body: { id: "draft-1", message: { id: "msg-1", threadId: "thread-1" } },
          };
        }
        throw new Error(`unexpected ${request.method} ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "gmail_draft");
    if (tool === undefined) throw new Error("gmail_draft not registered");

    const result = await tool.execute(
      { to: "alice@acme.com", subject: "Lunch", body: "1pm?" },
      context()
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        draftId: "draft-1",
        messageId: "msg-1",
        threadId: "thread-1",
      });
    }
    const body = sent.at(0) as { message: { raw: string } };
    const decoded = Buffer.from(body.message.raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: alice@acme.com");
    expect(decoded).toContain("Subject: Lunch");
    expect(decoded.endsWith("1pm?")).toBe(true);
  });

  it("replays the same effect instead of re-creating a draft on a repeated call id", async () => {
    let posts = 0;
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.method === "POST") {
          posts += 1;
          return { status: 200, headers: {}, body: { id: "draft-1", message: { id: "msg-1" } } };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "gmail_draft");
    if (tool === undefined) throw new Error("gmail_draft not registered");

    const args = { to: "a@b.com", subject: "S", body: "B" };
    const ctx = context();
    const first = await tool.execute(args, ctx);
    const second = await tool.execute(args, ctx);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (second.success) expect(second.data).toMatchObject({ replayed: true });
    expect(posts).toBe(1);
  });

  it("reports not_found when Gmail cannot find the message", async () => {
    const http = {
      async send() {
        return { status: 404, headers: {}, body: { error: { status: "NOT_FOUND" } } };
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "gmail_read");
    if (tool === undefined) throw new Error("gmail_read not registered");

    const result = await tool.execute({ messageId: "missing" }, context());
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("not_found");
  });

  it("fails closed with internal_error when the run context is missing", async () => {
    const tool = toolsWith({ async send() {} }).find((c) => c.name === "gmail_search");
    if (tool === undefined) throw new Error("gmail_search not registered");

    const result = await tool.execute({ query: "x" }, { userId: "u" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("internal_error");
  });

  it("lists calendar events and flattens their start, end, and attendees", async () => {
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/calendars/primary/events") {
          expect(request.query?.singleEvents).toBe("true");
          return {
            status: 200,
            headers: {},
            body: {
              items: [
                {
                  id: "evt-1",
                  summary: "Standup",
                  start: { dateTime: "2026-03-01T09:00:00Z" },
                  end: { dateTime: "2026-03-01T09:15:00Z" },
                  htmlLink: "https://cal/evt-1",
                  attendees: [{ email: "a@acme.com" }, { optional: true }],
                },
              ],
            },
          };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "calendar_list_events");
    if (tool === undefined) throw new Error("calendar_list_events not registered");

    const result = await tool.execute({}, context());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        events: [
          {
            id: "evt-1",
            summary: "Standup",
            start: "2026-03-01T09:00:00Z",
            end: "2026-03-01T09:15:00Z",
            htmlLink: "https://cal/evt-1",
            attendees: ["a@acme.com"],
          },
        ],
      });
    }
  });

  it("creates a calendar event, choosing date vs dateTime and wrapping attendees", async () => {
    const sent: unknown[] = [];
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.method === "POST" && request.path === "/calendars/primary/events") {
          sent.push(request.body);
          return {
            status: 200,
            headers: {},
            body: { id: "evt-9", htmlLink: "https://cal/evt-9", status: "confirmed" },
          };
        }
        throw new Error(`unexpected ${request.method} ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "calendar_create_event");
    if (tool === undefined) throw new Error("calendar_create_event not registered");

    const result = await tool.execute(
      { summary: "Launch", start: "2026-03-01", end: "2026-03-02", attendees: ["a@acme.com"] },
      context()
    );
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data).toEqual({
        eventId: "evt-9",
        htmlLink: "https://cal/evt-9",
        status: "confirmed",
      });
    expect(sent.at(0)).toMatchObject({
      summary: "Launch",
      start: { date: "2026-03-01" },
      end: { date: "2026-03-02" },
      attendees: [{ email: "a@acme.com" }],
    });
  });

  it("patches only the supplied fields when updating an event", async () => {
    let method = "";
    let body: unknown;
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/calendars/primary/events/evt-1") {
          method = request.method;
          body = request.body;
          return { status: 200, headers: {}, body: { id: "evt-1", status: "confirmed" } };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "calendar_update_event");
    if (tool === undefined) throw new Error("calendar_update_event not registered");

    const result = await tool.execute(
      {
        eventId: "evt-1",
        summary: "Renamed",
        start: "2026-03-01T10:00:00Z",
        end: "2026-03-01T10:30:00Z",
      },
      context()
    );
    expect(method).toBe("PATCH");
    expect(body).toEqual({
      summary: "Renamed",
      start: { dateTime: "2026-03-01T10:00:00Z" },
      end: { dateTime: "2026-03-01T10:30:00Z" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ eventId: "evt-1", status: "confirmed" });
  });

  it("deletes an event and reports it, treating 204 No Content as success", async () => {
    let method = "";
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/calendars/primary/events/evt-7") {
          method = request.method;
          return { status: 204, headers: {}, body: undefined };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "calendar_delete_event");
    if (tool === undefined) throw new Error("calendar_delete_event not registered");

    const result = await tool.execute({ eventId: "evt-7" }, context());
    expect(method).toBe("DELETE");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ eventId: "evt-7", deleted: true });
  });

  it("searches Drive, wrapping a plain keyword into a fullText query", async () => {
    let queried = "";
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/files") {
          queried = request.query?.q ?? "";
          return {
            status: 200,
            headers: {},
            body: {
              files: [
                {
                  id: "f1",
                  name: "Menu",
                  mimeType: "application/vnd.google-apps.document",
                  webViewLink: "https://drive/f1",
                },
              ],
            },
          };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "drive_search");
    if (tool === undefined) throw new Error("drive_search not registered");

    const result = await tool.execute({ query: "menu" }, context());
    expect(queried).toContain("fullText contains 'menu'");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        files: [
          {
            id: "f1",
            name: "Menu",
            mimeType: "application/vnd.google-apps.document",
            webViewLink: "https://drive/f1",
          },
        ],
      });
    }
  });

  it("reads a Google Doc and flattens its body text runs", async () => {
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/documents/doc-1") {
          return {
            status: 200,
            headers: {},
            body: {
              documentId: "doc-1",
              title: "Plan",
              body: {
                content: [
                  {
                    paragraph: {
                      elements: [
                        { textRun: { content: "Hello " } },
                        { textRun: { content: "world\n" } },
                      ],
                    },
                  },
                ],
              },
            },
          };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "docs_read");
    if (tool === undefined) throw new Error("docs_read not registered");

    const result = await tool.execute({ documentId: "doc-1" }, context());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ documentId: "doc-1", title: "Plan", body: "Hello world\n" });
    }
  });

  it("creates a doc and inserts the initial body via batchUpdate", async () => {
    const calls: string[] = [];
    const http = {
      async send(request: IntegrationHttpRequest) {
        calls.push(`${request.method} ${request.path}`);
        if (request.path === "/documents") {
          return { status: 200, headers: {}, body: { documentId: "doc-9", title: "Notes" } };
        }
        if (request.path === "/documents/doc-9:batchUpdate") {
          expect(request.body).toMatchObject({
            requests: [{ insertText: { location: { index: 1 }, text: "Body" } }],
          });
          return { status: 200, headers: {}, body: {} };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "docs_create");
    if (tool === undefined) throw new Error("docs_create not registered");

    const result = await tool.execute({ title: "Notes", body: "Body" }, context());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        documentId: "doc-9",
        title: "Notes",
        documentUrl: "https://docs.google.com/document/d/doc-9/edit",
      });
    }
    expect(calls).toEqual(["POST /documents", "POST /documents/doc-9:batchUpdate"]);
  });

  it("appends text to a doc at the end of the body segment", async () => {
    let body: unknown;
    const http = {
      async send(request: IntegrationHttpRequest) {
        if (request.path === "/documents/doc-3:batchUpdate") {
          body = request.body;
          return { status: 200, headers: {}, body: {} };
        }
        throw new Error(`unexpected ${request.path}`);
      },
    };
    const tool = toolsWith(http).find((candidate) => candidate.name === "docs_append");
    if (tool === undefined) throw new Error("docs_append not registered");

    const result = await tool.execute({ documentId: "doc-3", text: "More" }, context());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ documentId: "doc-3" });
    expect(body).toMatchObject({
      requests: [{ insertText: { endOfSegmentLocation: {}, text: "More" } }],
    });
  });
});
