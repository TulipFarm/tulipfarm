import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { AppShell, AppSidebar, modeForPath, titleForPath } from "~/components/app-sidebar";
import * as approvalsContext from "~/lib/approvals-context";
import * as conversationsContext from "~/lib/conversations-context";

vi.mock("~/lib/approvals-context", () => ({ useApprovals: vi.fn() }));
const useApprovals = vi.mocked(approvalsContext.useApprovals);

vi.mock("~/lib/conversations-context", () => ({ useConversations: vi.fn() }));
const useConversations = vi.mocked(conversationsContext.useConversations);

const SidebarStub = createRemixStub([{ path: "*", Component: AppSidebar }]);
const ShellStub = createRemixStub([
  {
    path: "*",
    Component: () => (
      <AppShell>
        <p>Page content</p>
      </AppShell>
    ),
  },
]);

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

test("maps deep routes to stable product modes and top-bar titles", () => {
  expect(modeForPath("/chat/c1")).toBe("chat");
  expect(modeForPath("/skills/forecasting")).toBe("build");
  expect(modeForPath("/knowledge/spaces/ops")).toBe("knowledge");
  expect(modeForPath("/runs/run-1")).toBe("operate");
  expect(modeForPath("/settings/llm")).toBe("settings");
  expect(titleForPath("/resources/tickets")).toBe("Resources");
  expect(titleForPath("/operations")).toBe("Operations");
});

test("renders the global product-mode rail and Chat context", () => {
  render(<SidebarStub initialEntries={["/"]} />);
  const rail = screen.getByRole("navigation", { name: "Product modes" });
  for (const label of ["Chat", "Build", "Knowledge", "Operate"]) {
    expect(within(rail).getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(within(rail).getByRole("link", { name: "Chat" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Recent chats" })).toHaveAttribute("href", "/chats");
});

test("renders Build destinations in the contextual sidebar", () => {
  render(<SidebarStub initialEntries={["/resources"]} />);
  expect(screen.getByRole("link", { name: "Build" })).toHaveAttribute("aria-current", "page");
  for (const label of ["Resources", "Agents", "Skills", "Routines"]) {
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(screen.queryByRole("link", { name: "Inbox" })).not.toBeInTheDocument();
});

test("renders Operate destinations and the live Inbox badge", () => {
  useApprovals.mockReturnValue({
    approvals: [],
    count: 2,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  render(<SidebarStub initialEntries={["/inbox"]} />);
  const inbox = screen.getByRole("link", { name: /inbox/i });
  expect(within(inbox).getByText("2")).toBeInTheDocument();
  for (const label of ["Inbox", "Runs", "Integrations", "Operations"]) {
    expect(screen.getByRole("link", { name: new RegExp(label, "i") })).toBeInTheDocument();
  }
});

test("renders Settings destinations and the development design guide", () => {
  render(<SidebarStub initialEntries={["/settings/llm"]} />);
  for (const label of ["Secrets", "LLM", "Observability", "Soul", "Activities", "Memory"]) {
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(screen.getByRole("link", { name: "Design guide" })).toHaveAttribute(
    "href",
    "/design-guide"
  );
});

test("renders recent chats and highlights the active Chat", () => {
  useConversations.mockReturnValue({
    conversations: [
      {
        id: "c1",
        title: "Inventory planning",
        agentId: null,
        starred: false,
        createdAt: "t",
        updatedAt: "t",
      },
      { id: "c2", title: null, agentId: null, starred: false, createdAt: "t", updatedAt: "t" },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
    activeChatId: "c1",
    setActiveChatId: vi.fn(),
    newChatNonce: 0,
    startNewChat: vi.fn(),
  });
  render(<SidebarStub initialEntries={["/"]} />);
  expect(screen.getByRole("link", { name: "Inventory planning" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute("href", "/chat/c2");
});

test("starts a fresh Chat from the contextual sidebar", async () => {
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
  render(<SidebarStub initialEntries={["/"]} />);
  await user.click(screen.getByRole("button", { name: "New chat" }));
  expect(startNewChat).toHaveBeenCalledTimes(1);
});

test("renders the shared top bar and restores focus after Escape closes navigation", async () => {
  const user = userEvent.setup();
  render(<ShellStub initialEntries={["/resources"]} />);
  expect(screen.getAllByText("Resources")).toHaveLength(2);
  expect(screen.getByText("Page content")).toBeInTheDocument();

  const opener = screen.getByRole("button", { name: "Open navigation" });
  await user.click(opener);
  expect(opener).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");
  expect(opener).toHaveAttribute("aria-expanded", "false");
  expect(opener).toHaveFocus();
});
