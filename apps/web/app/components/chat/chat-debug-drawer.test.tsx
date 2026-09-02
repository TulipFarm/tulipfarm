import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChatDebugDrawer, splitPromptBlocks } from "~/components/chat/chat-debug-drawer";
import { type DebugContext, getDebugContext } from "~/lib/conversations";

vi.mock("~/lib/conversations", () => ({
  getDebugContext: vi.fn(),
}));

// Shiki loads its grammars through dynamic imports that jsdom cannot resolve, so the hook would
// return `null` here anyway. Pinning it makes that the assertion target rather than a race: these
// tests cover the plaintext fallback, which is also what every block renders on first paint.
vi.mock("~/lib/use-highlighted", () => ({
  useHighlighted: () => null,
}));

const DEBUG: DebugContext = {
  conversationId: "c1",
  systemPrompt:
    "<platform-instructions>\nrank: PLATFORM_MARKER\n</platform-instructions>\n<agent-personality>\nagentId: SYS_PROMPT_MARKER\n</agent-personality>",
  soulReminder:
    "<soul>\n<available-skills>\nticket-triage: REMINDER_MARKER\n</available-skills>\n</soul>",
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
  tools: [
    {
      name: "search",
      description: "TOOL_DESCRIPTION_MARKER",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDebugContext).mockResolvedValue(DEBUG);
});

async function openDrawer() {
  const user = userEvent.setup();
  render(<ChatDebugDrawer conversationId="c1" />);
  await user.click(screen.getByRole("button", { name: /open debug drawer/i }));
  await screen.findByText(/SYS_PROMPT_MARKER/);
  return user;
}

describe("splitPromptBlocks", () => {
  test("splits the prompt on whole-line block tags and strips them from the body", () => {
    expect(splitPromptBlocks("<a>\none\n</a>\n<b>\ntwo\n</b>")).toEqual([
      { tag: "<a>", body: "one" },
      { tag: "<b>", body: "two" },
    ]);
  });

  test("keeps text that sits outside any block rather than dropping it", () => {
    expect(splitPromptBlocks("loose\n<a>\none\n</a>")).toEqual([
      { tag: "(untagged)", body: "loose" },
      { tag: "<a>", body: "one" },
    ]);
  });

  test("does not treat an inline tag as a block boundary", () => {
    expect(splitPromptBlocks("<a>\nsee <b> here\n</a>")).toEqual([
      { tag: "<a>", body: "see <b> here" },
    ]);
  });
});

test("the button is disabled until there is a conversation id", () => {
  render(<ChatDebugDrawer conversationId={undefined} />);
  expect(screen.getByRole("button", { name: /open debug drawer/i })).toBeDisabled();
});

test("the prompt view renders one collapsible section per block, as text", async () => {
  render(<ChatDebugDrawer conversationId="c1" />);
  expect(screen.queryByRole("complementary")).toBeNull();

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /open debug drawer/i }));
  await screen.findByText(/SYS_PROMPT_MARKER/);

  const panel = screen.getByRole("complementary");
  expect(getDebugContext).toHaveBeenCalledWith("c1");
  // Each block heads its own section, and no newline survives as a literal `\n` escape.
  expect(screen.getByRole("button", { name: /<platform-instructions>/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /<agent-personality>/ })).toBeTruthy();
  expect(panel.textContent).not.toContain("\\n");
  // The prompt view is the prompt alone; message rows belong to the JSON view.
  expect(panel.textContent).not.toContain("hello there");
});

test("collapsing a prompt block unmounts its body", async () => {
  const user = await openDrawer();
  const toggle = screen.getByRole("button", { name: /<agent-personality>/ });
  expect(toggle).toHaveAttribute("aria-expanded", "true");

  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(/SYS_PROMPT_MARKER/)).toBeNull();
  // Its sibling is untouched.
  expect(screen.getByText(/PLATFORM_MARKER/)).toBeTruthy();
});

test("the prompt view shows the injected Soul reminder, which is never persisted", async () => {
  await openDrawer();
  expect(screen.getByText(/REMINDER_MARKER/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /system-reminder/ })).toBeTruthy();
});

test("the prompt view says so when the reader gets no Soul reminder", async () => {
  vi.mocked(getDebugContext).mockResolvedValue({ ...DEBUG, soulReminder: "" });
  await openDrawer();
  expect(screen.getByText(/No Soul reminder for this reader/)).toBeTruthy();
});

test("the JSON view lists every row the model receives, synthetic ones included", async () => {
  const user = await openDrawer();
  await user.click(screen.getByRole("button", { name: "JSON" }));

  // Synthetic rows are collapsed by default — they are the two largest and are already readable
  // in full on the Prompt tab.
  expect(screen.getByRole("button", { name: /\[0\] system · synthetic/ })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  expect(screen.getByRole("button", { name: /\[1\] user · synthetic/ })).toBeTruthy();

  const panel = screen.getByRole("complementary");
  expect(panel.textContent).toContain("tool-call");
  expect(panel.textContent).toContain("hello there");

  await user.click(screen.getByRole("button", { name: /\[0\] system · synthetic/ }));
  expect(screen.getByRole("complementary").textContent).toContain('"role": "system"');
});

test("Copy in the prompt view writes the prompt and the reminder", async () => {
  // userEvent.setup() installs a working navigator.clipboard stub; assert via its readText().
  const user = await openDrawer();
  await user.click(screen.getByRole("button", { name: /^copy$/i }));

  const copied = await navigator.clipboard.readText();
  expect(copied).toContain("SYS_PROMPT_MARKER");
  expect(copied).toContain("REMINDER_MARKER");
});

test("Copy in the JSON view writes the whole payload, not just the open rows", async () => {
  const user = await openDrawer();
  await user.click(screen.getByRole("button", { name: "JSON" }));
  await user.click(screen.getByRole("button", { name: /^copy$/i }));

  const copied = await navigator.clipboard.readText();
  expect(copied).toContain("SYS_PROMPT_MARKER");
  expect(copied).toContain("REMINDER_MARKER");
  expect(copied).toContain("hello there");
});

test("closes via the X button", async () => {
  const user = await openDrawer();
  await user.click(screen.getByRole("button", { name: /close/i }));
  expect(screen.queryByRole("complementary")).toBeNull();
});
