import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ChatDebugDrawer } from "~/components/chat/chat-debug-drawer";
import { type DebugContext, getDebugContext } from "~/lib/conversations";

vi.mock("~/lib/conversations", () => ({
  getDebugContext: vi.fn(),
}));

const DEBUG: DebugContext = {
  conversationId: "c1",
  systemPrompt: "<agent-personality>\nagentId: SYS_PROMPT_MARKER\n</agent-personality>",
  messages: [
    { _id: "m1", conversationId: "c1", role: "user", content: "hello there", createdAt: "t0" },
    {
      _id: "m2",
      conversationId: "c1",
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "tc1", toolName: "search", args: { q: "x" } }],
      createdAt: "t1",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDebugContext).mockResolvedValue(DEBUG);
});

test("the button is disabled until there is a conversation id", () => {
  render(<ChatDebugDrawer conversationId={undefined} />);
  expect(screen.getByRole("button", { name: /open debug drawer/i })).toBeDisabled();
});

test("opens on the prompt view and renders it as text, not as an escaped JSON string", async () => {
  const user = userEvent.setup();
  render(<ChatDebugDrawer conversationId="c1" />);

  // Closed initially — no slide-over.
  expect(screen.queryByRole("complementary")).toBeNull();

  await user.click(screen.getByRole("button", { name: /open debug drawer/i }));

  await screen.findByText(/SYS_PROMPT_MARKER/);
  const panel = screen.getByRole("complementary");
  expect(getDebugContext).toHaveBeenCalledWith("c1");
  // Block tags are their own nodes, and no newline survives as a literal `\n` escape.
  expect(screen.getByText("<agent-personality>")).toBeTruthy();
  expect(panel.textContent).not.toContain("\\n");
  // The prompt view is the prompt alone; message rows belong to the JSON view.
  expect(panel.textContent).not.toContain("hello there");
});

test("the JSON view dumps the system prompt + raw rows", async () => {
  const user = userEvent.setup();
  render(<ChatDebugDrawer conversationId="c1" />);
  await user.click(screen.getByRole("button", { name: /open debug drawer/i }));
  await screen.findByText(/SYS_PROMPT_MARKER/);

  await user.click(screen.getByRole("button", { name: "JSON" }));

  // The JSON is split across highlight spans, so read textContent off the whole drawer region.
  const panel = screen.getByRole("complementary");
  expect(panel.textContent).toContain('"role": "system"');
  expect(panel.textContent).toContain("tool-call");
  expect(panel.textContent).toContain("hello there");
});

test("Copy in the prompt view writes the raw prompt to the clipboard", async () => {
  // userEvent.setup() installs a working navigator.clipboard stub; assert via its readText().
  const user = userEvent.setup();
  render(<ChatDebugDrawer conversationId="c1" />);
  await user.click(screen.getByRole("button", { name: /open debug drawer/i }));
  await screen.findByText(/SYS_PROMPT_MARKER/);

  await user.click(screen.getByRole("button", { name: /^copy$/i }));
  expect(await navigator.clipboard.readText()).toBe(DEBUG.systemPrompt);
});

test("Copy in the JSON view writes the JSON payload to the clipboard", async () => {
  const user = userEvent.setup();
  render(<ChatDebugDrawer conversationId="c1" />);
  await user.click(screen.getByRole("button", { name: /open debug drawer/i }));
  await screen.findByText(/SYS_PROMPT_MARKER/);

  await user.click(screen.getByRole("button", { name: "JSON" }));
  await user.click(screen.getByRole("button", { name: /^copy$/i }));
  const copied = await navigator.clipboard.readText();
  expect(copied).toContain("SYS_PROMPT_MARKER");
  expect(copied).toContain("hello there");
});

test("closes via the X button", async () => {
  const user = userEvent.setup();
  render(<ChatDebugDrawer conversationId="c1" />);
  await user.click(screen.getByRole("button", { name: /open debug drawer/i }));
  await screen.findByText(/SYS_PROMPT_MARKER/);

  await user.click(screen.getByRole("button", { name: /close/i }));
  expect(screen.queryByRole("complementary")).toBeNull();
});
