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
  systemPrompt: "SYS_PROMPT_MARKER",
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

test("opens the drawer and dumps the system prompt + raw rows as JSON", async () => {
  const user = userEvent.setup();
  render(<ChatDebugDrawer conversationId="c1" />);

  // Closed initially — no slide-over.
  expect(screen.queryByRole("complementary")).toBeNull();

  await user.click(screen.getByRole("button", { name: /open debug drawer/i }));

  // Wait for the async fetch+render, then assert on the panel's flattened text (the JSON is now split
  // across highlight spans, so read textContent off the whole drawer region rather than one node).
  await screen.findByText(/SYS_PROMPT_MARKER/);
  const panel = screen.getByRole("complementary");
  expect(getDebugContext).toHaveBeenCalledWith("c1");
  expect(panel.textContent).toContain('"role": "system"');
  expect(panel.textContent).toContain("tool-call");
  expect(panel.textContent).toContain("hello there");
});

test("Copy JSON writes the payload to the clipboard", async () => {
  // userEvent.setup() installs a working navigator.clipboard stub; assert via its readText().
  const user = userEvent.setup();
  render(<ChatDebugDrawer conversationId="c1" />);
  await user.click(screen.getByRole("button", { name: /open debug drawer/i }));
  await screen.findByText(/SYS_PROMPT_MARKER/);

  await user.click(screen.getByRole("button", { name: /copy json/i }));
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
