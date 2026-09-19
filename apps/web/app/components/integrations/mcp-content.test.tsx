import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { readMcpResource, renderMcpPrompt } from "~/lib/mcp-integrations";
import { McpContent } from "./mcp-content";

vi.mock("~/lib/mcp-integrations", () => ({ readMcpResource: vi.fn(), renderMcpPrompt: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const capabilities = {
  tools: [],
  resources: [{ name: "Handbook", uri: "docs://handbook", digest: "resource-digest" }],
  prompts: [
    { name: "Review", digest: "prompt-digest", arguments: [{ name: "topic", required: true }] },
  ],
};

test("resource reads use the saved Chat account context, not an arbitrary credential", async () => {
  vi.mocked(readMcpResource).mockResolvedValue({
    contents: [{ uri: "docs://handbook", text: "Handbook contents" }],
  });
  render(
    <McpContent
      serverId="support"
      capabilities={capabilities}
      enabled
      context={{ chatId: "chat-1" }}
    />
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Approved resource" }));
  await userEvent.click(await screen.findByRole("option", { name: /Handbook/ }));
  expect(readMcpResource).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Read resource" }));
  expect(readMcpResource).toHaveBeenCalledWith("support", "docs://handbook", { chatId: "chat-1" });
  expect(
    await screen.findByRole("region", { name: "Integration content preview" })
  ).toHaveTextContent("Handbook contents");
  expect(screen.getByText("Handbook contents")).toBeVisible();
  expect(screen.getByText(/"contents":/)).not.toBeVisible();
  await userEvent.click(screen.getByText("Technical details · Provider response"));
  expect(screen.getByText(/"contents":/)).toBeVisible();
});

test("prompt previews collect declared arguments without automatically running instructions", async () => {
  vi.mocked(renderMcpPrompt).mockResolvedValue({
    messages: [{ role: "user", content: { type: "text", text: "Review the report." } }],
  });
  render(
    <McpContent
      serverId="support"
      capabilities={capabilities}
      enabled
      context={{ chatId: "chat-1" }}
    />
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Approved prompt" }));
  await userEvent.click(await screen.findByRole("option", { name: "Review" }));
  await userEvent.type(screen.getByLabelText("topic"), "report");
  await userEvent.click(screen.getByRole("button", { name: "Preview prompt" }));
  expect(renderMcpPrompt).toHaveBeenCalledWith(
    "support",
    "Review",
    { topic: "report" },
    { chatId: "chat-1" }
  );
  expect(readMcpResource).not.toHaveBeenCalled();
});

test("failed live authorization shows an error without stale content", async () => {
  vi.mocked(readMcpResource).mockRejectedValue(new Error("Source access was revoked."));
  render(
    <McpContent
      serverId="support"
      capabilities={capabilities}
      enabled
      context={{ chatId: "chat-1" }}
    />
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Approved resource" }));
  await userEvent.click(await screen.findByRole("option", { name: /Handbook/ }));
  await userEvent.click(screen.getByRole("button", { name: "Read resource" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Source access was revoked.");
  expect(
    screen.queryByRole("region", { name: "Integration content preview" })
  ).not.toBeInTheDocument();
});
