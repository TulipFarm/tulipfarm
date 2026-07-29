import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ChatPanel } from "~/components/chat/chat-panel";
import type { Suggestion } from "~/lib/onboarding";

// ChatPanel drives the conversation through useChatStream; mock it so the empty-state surface
// renders deterministically and `send` is observable.
const send = vi.fn();
vi.mock("~/lib/chat/use-chat-stream", () => ({
  useChatStream: () => ({
    messages: [],
    status: "ready",
    error: null,
    send,
    approve: vi.fn(),
    regenerate: vi.fn(),
    reset: vi.fn(),
    sendSurfaceInteraction: vi.fn(),
  }),
}));

beforeEach(() => send.mockClear());

const SUGGESTIONS: Suggestion[] = [
  {
    id: "tickets",
    label: "Set up ticket management?",
    prompt: "Help me set up ticket management.",
  },
  { id: "leads", label: "Track sales leads?", prompt: "Help me track sales leads." },
];

test("renders one chip per adaptive suggestion using its label (ONB-V1-002)", () => {
  render(<ChatPanel suggestions={SUGGESTIONS} />);
  expect(screen.getByRole("button", { name: "Set up ticket management?" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Track sales leads?" })).toBeInTheDocument();
});

test("tapping a chip seeds the chat with its prompt (not its label)", async () => {
  const user = userEvent.setup();
  render(<ChatPanel suggestions={SUGGESTIONS} />);

  await user.click(screen.getByRole("button", { name: "Set up ticket management?" }));

  expect(send).toHaveBeenCalledWith("Help me set up ticket management.", {
    model: "standard",
    agentId: undefined,
  });
});

test("with no suggestions, renders no chips but the composer stays interactive (default = [])", () => {
  render(<ChatPanel />);
  expect(screen.queryByRole("button", { name: /set up|track|manage/i })).toBeNull();
  expect(screen.getByLabelText("Message")).toBeInTheDocument();
});
