import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ChatPanel } from "~/components/chat/chat-panel";
import type { ChatMessage } from "~/lib/chat/types";
import type { Suggestion } from "~/lib/onboarding";

// ChatPanel drives the conversation through useChatStream; mock it so the empty-state surface
// renders deterministically and `send` is observable.
const send = vi.fn();
const regenerate = vi.fn();
let stream: {
  messages: ChatMessage[];
  status: string;
  error: string | null;
  errorDetails?: {
    reason?: string;
    requestId?: string;
    modelId?: string;
  };
  send: typeof send;
  approve: ReturnType<typeof vi.fn>;
  regenerate: typeof regenerate;
  reset: ReturnType<typeof vi.fn>;
  sendSurfaceInteraction: ReturnType<typeof vi.fn>;
} = {
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

test("renders one chip per adaptive suggestion using its label (ONB-V1-002)", async () => {
  render(<ChatPanel suggestions={SUGGESTIONS} />);
  // The composer is code-split, so its chips arrive with its chunk rather than on first render.
  expect(
    await screen.findByRole("button", { name: "Set up ticket management?" })
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Track sales leads?" })).toBeInTheDocument();
});

test("tapping a Suggested prompt does not immediately start a Turn", async () => {
  const user = userEvent.setup();
  render(<ChatPanel suggestions={SUGGESTIONS} />);

  await user.click(await screen.findByRole("button", { name: "Set up ticket management?" }));

  expect(send).not.toHaveBeenCalled();
});

test("with no suggestions, renders no chips but the composer stays interactive (default = [])", () => {
  render(<ChatPanel />);
  expect(screen.queryByRole("button", { name: /set up|track|manage/i })).toBeNull();
  expect(screen.getByLabelText("Message").closest("[data-composer-placement]")).toHaveAttribute(
    "data-composer-placement",
    "centered"
  );
});

test("rotates generic greetings when no profile name is set", () => {
  render(<ChatPanel greetingIndex={1} />);
  expect(screen.getByRole("heading", { name: "Where should we start?" })).toBeInTheDocument();
  expect(
    screen.queryByText("Describe what you want to do, build, or understand.")
  ).not.toBeInTheDocument();
});

test("uses the profile's first name in personalized greetings", () => {
  render(<ChatPanel userName="Muskan Vijayvargiya" greetingIndex={1} />);
  expect(
    screen.getByRole("heading", { name: "Where should we start, Muskan?" })
  ).toBeInTheDocument();
});

test("does not personalize greetings for a blank profile name", () => {
  render(<ChatPanel userName="   " greetingIndex={2} />);
  expect(screen.getByRole("heading", { name: "What needs sorting out?" })).toBeInTheDocument();
});

test("docks one composer beneath the transcript after the first message", async () => {
  stream = {
    ...stream,
    messages: [
      {
        id: "message-1",
        role: "user",
        parts: [{ kind: "text", text: "Hello" }],
        sealed: true,
      },
    ],
  };

  render(<ChatPanel suggestions={SUGGESTIONS} />);

  expect(await screen.findByText("Hello")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "What’s on your mind?" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Set up ticket management?" })).toBeNull();
  expect(screen.getAllByLabelText("Message")).toHaveLength(1);
  expect(screen.getByLabelText("Message").closest("[data-composer-placement]")).toHaveAttribute(
    "data-composer-placement",
    "docked"
  );
});

test("normal Chat does not present the default harness as a user-created Agent", () => {
  render(<ChatPanel businessName="Acme Tulips" />);
  expect(
    screen.getByRole("heading", { name: "Where should we start with Acme Tulips?" })
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
