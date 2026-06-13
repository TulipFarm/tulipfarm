import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { AppSidebar } from "~/components/app-sidebar";
import * as approvalsContext from "~/lib/approvals-context";
import * as conversationsContext from "~/lib/conversations-context";

// The badge count now comes from the live ApprovalsProvider context (inert fallback is covered in
// approvals-context.test.tsx); mock the hook here for deterministic counts.
vi.mock("~/lib/approvals-context", () => ({ useApprovals: vi.fn() }));
const useApprovals = vi.mocked(approvalsContext.useApprovals);

// Recent chats read the shared ConversationsProvider; mock it for deterministic lists.
vi.mock("~/lib/conversations-context", () => ({ useConversations: vi.fn() }));
const useConversations = vi.mocked(conversationsContext.useConversations);

const Stub = createRemixStub([{ path: "/", Component: AppSidebar }]);

beforeEach(() => {
  localStorage.clear();
  useApprovals.mockReturnValue({
    approvals: [],
    count: 0,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  useConversations.mockReturnValue({
    conversations: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    activeChatId: null,
    setActiveChatId: vi.fn(),
    newChatNonce: 0,
    startNewChat: vi.fn(),
  });
});

test("renders all eight V1 sidebar sections", () => {
  render(<Stub initialEntries={["/"]} />);
  for (const label of [
    "Chat",
    "Resources",
    "Agents",
    "Routines",
    "Approvals",
    "Knowledge",
    "Integrations",
    "Settings",
  ]) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});

test("does not render an Apps section (AC-V1-003)", () => {
  render(<Stub initialEntries={["/"]} />);
  expect(screen.queryByText("Apps")).not.toBeInTheDocument();
});

test("renders no Approvals badge when there are no pending approvals", () => {
  render(<Stub initialEntries={["/"]} />);
  const approvalsLink = screen.getByRole("link", { name: /approvals/i });
  expect(within(approvalsLink).queryByText(/^\d+$/)).toBeNull();
});

test("renders the live Approvals badge count from context", () => {
  useApprovals.mockReturnValue({
    approvals: [],
    count: 2,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  render(<Stub initialEntries={["/"]} />);
  const approvalsLink = screen.getByRole("link", { name: /approvals/i });
  expect(within(approvalsLink).getByText("2")).toBeInTheDocument();
});

test("renders a compact headerless nav (no Workspace/System section labels) + footer theme toggle", () => {
  render(<Stub initialEntries={["/"]} />);
  // Section headers were dropped for Claude-style density; the nav items themselves still render.
  expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  expect(screen.queryByText("System")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Chat" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /toggle dark mode/i })).toBeInTheDocument();
});

test("renders a Recent chats list linking each conversation to /chat/:id", () => {
  useConversations.mockReturnValue({
    conversations: [
      { id: "c1", title: "Inventory Planning", agentId: null, createdAt: "t", updatedAt: "t" },
      { id: "c2", title: null, agentId: null, createdAt: "t", updatedAt: "t" },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
    activeChatId: null,
    setActiveChatId: vi.fn(),
    newChatNonce: 0,
    startNewChat: vi.fn(),
  });
  render(<Stub initialEntries={["/"]} />);
  expect(screen.getByText("Recent chats")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Inventory Planning" })).toHaveAttribute(
    "href",
    "/chat/c1"
  );
  // A conversation whose async title has not landed yet falls back to "New chat".
  expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute("href", "/chat/c2");
});

test("highlights the active conversation and un-highlights Chat (shallow-routing aware)", () => {
  useConversations.mockReturnValue({
    conversations: [
      { id: "c1", title: "Inventory Planning", agentId: null, createdAt: "t", updatedAt: "t" },
      { id: "c2", title: "Budget Review", agentId: null, createdAt: "t", updatedAt: "t" },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
    // A chat opened via shallow replaceState: router location is still "/".
    activeChatId: "c1",
    setActiveChatId: vi.fn(),
    newChatNonce: 0,
    startNewChat: vi.fn(),
  });
  render(<Stub initialEntries={["/"]} />);

  // The active conversation carries aria-current=page; the other does not.
  expect(screen.getByRole("link", { name: "Inventory Planning" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(screen.getByRole("link", { name: "Budget Review" })).not.toHaveAttribute("aria-current");
  // Even though the router still reads "/", the Chat nav item is NOT marked active.
  expect(screen.getByRole("link", { name: "Chat" })).not.toHaveAttribute("aria-current", "page");
});

test("renders a New chat button that calls startNewChat", async () => {
  const user = userEvent.setup();
  const startNewChat = vi.fn();
  useConversations.mockReturnValue({
    conversations: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    activeChatId: null,
    setActiveChatId: vi.fn(),
    newChatNonce: 0,
    startNewChat,
  });
  render(<Stub initialEntries={["/"]} />);
  await user.click(screen.getByRole("button", { name: /new chat/i }));
  expect(startNewChat).toHaveBeenCalledTimes(1);
});

test("renders no Recent chats section when there are no conversations", () => {
  render(<Stub initialEntries={["/"]} />);
  expect(screen.queryByText("Recent chats")).not.toBeInTheDocument();
});

test("collapsing the sidebar hides labels and persists the choice", async () => {
  const user = userEvent.setup();
  render(<Stub initialEntries={["/"]} />);
  expect(screen.getByText("Resources")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));

  expect(screen.queryByText("Resources")).not.toBeInTheDocument();
  expect(localStorage.getItem("sidebar-collapsed")).toBe("true");
});
