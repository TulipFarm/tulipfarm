import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ChatPanel } from "~/components/chat/chat-panel";
import type { Suggestion } from "~/lib/onboarding";

// ChatPanel drives the conversation through useChatStream; mock it so the empty-state surface
// renders deterministically and `send` is observable.
const send = vi.fn();
const regenerate = vi.fn();
let stream = {
  messages: [],
  status: "ready",
  error: null,
  errorDetails: undefined,
  send,
  approve: vi.fn(),
  regenerate,
  reset: vi.fn(),
  sendSurfaceInteraction: vi.fn(),
};
vi.mock("~/lib/chat/use-chat-stream", () => ({
  useChatStream: () => stream,
}));

beforeEach(() => {
  send.mockClear();
  regenerate.mockClear();
  stream = {
    messages: [],
    status: "ready",
    error: null,
    errorDetails: undefined,
    send,
    approve: vi.fn(),
    regenerate,
    reset: vi.fn(),
    sendSurfaceInteraction: vi.fn(),
  };
});

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

test("tapping a Suggested prompt does not immediately start a Turn", async () => {
  const user = userEvent.setup();
  render(<ChatPanel suggestions={SUGGESTIONS} />);

  await user.click(screen.getByRole("button", { name: "Set up ticket management?" }));

  expect(send).not.toHaveBeenCalled();
});

test("with no suggestions, renders no chips but the composer stays interactive (default = [])", () => {
  render(<ChatPanel />);
  expect(screen.queryByRole("button", { name: /set up|track|manage/i })).toBeNull();
  expect(screen.getByLabelText("Message")).toBeInTheDocument();
});

test("normal Chat does not present the default harness as a user-created Agent", () => {
  render(<ChatPanel businessName="Acme Tulips" />);
  expect(
    screen.getByRole("heading", { name: "What can I help Acme Tulips with?" })
  ).toBeInTheDocument();
  expect(screen.queryByText("TulipFarm")).not.toBeInTheDocument();
});

test("an explicitly selected Agent is identified above the Chat", () => {
  render(<ChatPanel agentId="InventoryPlanner" />);
  expect(screen.getByRole("heading", { name: "Chat with InventoryPlanner" })).toBeInTheDocument();
  expect(screen.getByText("This Chat is using a user-created Agent.")).toBeInTheDocument();
});

test("shows a safe model-failure reference and retries a temporary model failure", async () => {
  const user = userEvent.setup();
  stream = {
    ...stream,
    status: "error",
    error: "The model provider is temporarily unavailable. Try again shortly.",
    errorDetails: {
      reason: "model_provider_unavailable",
      requestId: "run-1:invoke:1",
      modelId: "gpt-5.6-terra",
    },
  };

  render(<ChatPanel />);

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Class: model_provider_unavailable · Model: gpt-5.6-terra · Reference: run-1:invoke:1"
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(regenerate).toHaveBeenCalledOnce();
});
