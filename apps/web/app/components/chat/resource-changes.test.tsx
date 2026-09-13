import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { messagesToTimeline } from "~/lib/chat/hydrate";
import type { ChatMessage, TimelinePart } from "~/lib/chat/types";
import { Transcript } from "./transcript";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;
const recordId = "e97841ce-1733-4c4f-b5e4-d34441768a49";

function tool(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: "tool",
    toolCallId: "create-record",
    toolName: "record_create",
    status: "done",
    outcome: "ok",
    args: { type: "tickets" },
    result: { id: recordId, version: 1, title: "Welcome email", status: "open" },
    ...overrides,
  };
}

function show(parts: TimelinePart[], options: Partial<ChatMessage> = {}) {
  const Stub = createRemixStub([
    {
      path: "/",
      Component: () => (
        <Transcript
          messages={[{ id: "reply", role: "assistant", sealed: true, parts, ...options }]}
          status={options.sealed === false ? "streaming" : "idle"}
          onApprove={vi.fn()}
        />
      ),
    },
  ]);
  return render(<Stub />);
}

describe("Resource changes in Chat", () => {
  it("keeps confirmed work reachable outside the collapsed Tool trace", async () => {
    show([
      tool({
        toolCallId: "create-type",
        toolName: "create_resource_type",
        args: { name: "tickets" },
        result: { name: "tickets", schema: "type: object", hasHooks: false },
      }),
      tool(),
      { kind: "text", text: "Your tickets are ready." },
    ]);

    const changes = await screen.findByRole("region", { name: "Resource changes" });
    expect(
      within(changes).getByRole("heading", { name: "Resource changes", level: 2 })
    ).toBeInTheDocument();
    expect(within(changes).getByRole("link", { name: "tickets" })).toHaveAttribute(
      "href",
      "/resources/tickets/schema"
    );
    expect(within(changes).getByRole("link", { name: "Welcome email" })).toHaveAttribute(
      "href",
      `/resources/tickets/${recordId}`
    );
    expect(within(changes).getByText("Saved record")).toBeInTheDocument();
    expect(screen.getByText("Your tickets are ready.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ran 2 tools/ })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("uses the persisted, redacted previews rather than digest placeholders", async () => {
    const [message] = messagesToTimeline([
      {
        _id: "saved-reply",
        conversationId: "chat-1",
        role: "assistant",
        content: "Saved.",
        createdAt: "2026-09-13T06:30:00Z",
        metadata: {
          toolCalls: [
            {
              callId: "create-record",
              name: "record_create",
              argsDigest: "digest",
              outcome: "ok",
              argsPreview: { json: JSON.stringify({ type: "tickets" }) },
              resultPreview: {
                json: JSON.stringify({ id: recordId, version: 1, title: "Saved reply" }),
              },
            },
          ],
        },
      },
    ]);
    expect(message).toBeDefined();
    show(message?.parts ?? []);
    expect(await screen.findByRole("link", { name: "Saved reply" })).toHaveAttribute(
      "href",
      `/resources/tickets/${recordId}`
    );
  });

  it("accepts the live success envelope, without treating a Record's status as a Tool error", async () => {
    show([
      tool({
        outcome: undefined,
        result: {
          status: "ok",
          data: { id: recordId, version: 1, title: "Error report", status: "error" },
        },
      }),
    ]);
    expect(await screen.findByRole("link", { name: "Error report" })).toBeInTheDocument();
  });

  it("does not unwrap a Record's own data field", async () => {
    show([
      tool({
        result: {
          id: recordId,
          version: 1,
          title: "Payload report",
          status: "ok",
          data: { title: "Nested data" },
        },
      }),
    ]);
    expect(await screen.findByRole("link", { name: "Payload report" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Nested data" })).not.toBeInTheDocument();
  });

  it("links a confirmed schema update to the returned resource type", async () => {
    show([
      tool({
        toolName: "update_resource_type",
        args: { name: "tickets" },
        result: { name: "tickets", schema: "type: object", hasHooks: false },
      }),
    ]);
    const changes = await screen.findByRole("region", { name: "Resource changes" });
    expect(within(changes).getByText("Updated schema")).toBeInTheDocument();
    expect(within(changes).getByRole("link", { name: "tickets" })).toHaveAttribute(
      "href",
      "/resources/tickets/schema"
    );
  });

  it.each([
    { status: "running" as const },
    { status: "interrupted" as const },
    { outcome: "error" as const },
    { outcome: undefined },
    { meta: { errorCode: "denied" } },
    { toolName: "record_get" },
    { toolName: "unrecognized_create" },
    { args: { type: "../settings" } },
    { result: { id: "..", version: 1 } },
    { result: { title: "No identifier" } },
    { resultPreview: { json: "{" } },
    { argsPreview: { json: "{" } },
    { argsPreview: { json: JSON.stringify({ type: "tickets" }), truncated: true } },
    { resultPreview: { json: JSON.stringify({ id: recordId }), truncated: true } },
    {
      argsPreview: {
        json: JSON.stringify({ type: "tickets" }),
        redactedPaths: ["type"],
      },
    },
    {
      resultPreview: {
        json: JSON.stringify({ id: recordId, version: 1, title: "[redacted]" }),
        redactedPaths: ["title"],
      },
    },
  ])("does not fabricate results from incomplete or failed evidence: %j", async (overrides) => {
    show([tool(overrides), { kind: "text", text: "Reply" }]);
    await screen.findByText("Reply");
    expect(screen.queryByRole("region", { name: "Resource changes" })).not.toBeInTheDocument();
  });

  it("shows only the latest confirmed change per Record and keeps its returned label", async () => {
    show([
      tool(),
      tool({
        toolCallId: "update-record",
        toolName: "record_update",
        args: { type: "tickets", id: recordId, version: 1 },
        result: { id: recordId, version: 2, title: "Revised welcome email" },
      }),
    ]);
    const changes = await screen.findByRole("region", { name: "Resource changes" });
    expect(within(changes).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(changes).getByRole("link", { name: "Revised welcome email" })
    ).toBeInTheDocument();
    expect(within(changes).getByText("Updated record")).toBeInTheDocument();
  });

  it("does not keep an open link after the same Record was deleted", async () => {
    show([
      tool(),
      tool({
        toolCallId: "delete-record",
        toolName: "record_delete",
        args: { type: "tickets", id: recordId, version: 1 },
        result: { id: recordId },
      }),
    ]);
    const changes = await screen.findByRole("region", { name: "Resource changes" });
    expect(within(changes).queryByRole("link")).not.toBeInTheDocument();
    expect(within(changes).getByText("Welcome email")).toBeInTheDocument();
    expect(within(changes).getByText("Deleted record")).toBeInTheDocument();
  });

  it("keeps confirmed changes visible even when a later Tool failed", async () => {
    show([
      tool(),
      tool({ toolCallId: "failed-update", toolName: "record_update", outcome: "error" }),
      { kind: "text", text: "A later step failed." },
    ]);
    expect(await screen.findByRole("link", { name: "Welcome email" })).toBeInTheDocument();
    expect(screen.queryByText("Updated record")).not.toBeInTheDocument();
  });

  it("waits for the reply to settle before adding its work summary", async () => {
    show([tool(), { kind: "text", text: "Still working" }], { sealed: false });
    await screen.findByRole("article", { name: "Assistant response" });
    expect(screen.queryByRole("region", { name: "Resource changes" })).not.toBeInTheDocument();
  });
});
