import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookOpen, Inbox, MessageSquare } from "lucide-react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  AppShell,
  AppSidebar,
  iconForPath,
  modeForPath,
  titleForPath,
} from "~/components/app-sidebar";
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
const AccountShellStub = createRemixStub([
  {
    path: "*",
    Component: () => (
      <AppShell
        isAdmin
        user={{ id: "u1", email: "priya.nair@northgate.dev", role: "admin", status: "active" }}
      >
        <p>Page content</p>
      </AppShell>
    ),
  },
]);

const CONVERSATIONS = {
  conversations: [],
  loading: false,
  error: null,
  refresh: vi.fn(),
  activeChatId: null,
  setActiveChatId: vi.fn(),
  activeChatTitle: null,
  setActiveChatTitle: vi.fn(),
  newChatNonce: 0,
  startNewChat: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  useApprovals.mockReturnValue({
    approvals: [],
    count: 0,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  useConversations.mockReturnValue(CONVERSATIONS);
});

test("maps deep routes to stable product modes and top-bar titles", () => {
  expect(modeForPath("/chat/c1")).toBe("chat");
  expect(modeForPath("/skills/forecasting")).toBe("build");
  expect(modeForPath("/knowledge/spaces/ops")).toBe("knowledge");
  expect(modeForPath("/runs/run-1")).toBe("operate");
  expect(modeForPath("/settings/llm")).toBe("settings");
  expect(modeForPath("/design-guide")).toBe("settings");
  expect(titleForPath("/resources/tickets")).toBe("Resources");
  expect(titleForPath("/operations")).toBe("Operations");
});

test("gives every page its own top-bar icon instead of the Chat glyph", () => {
  expect(iconForPath("/inbox")).toBe(Inbox);
  expect(iconForPath("/knowledge/spaces/ops")).toBe(BookOpen);
  expect(iconForPath("/chat/c1")).toBe(MessageSquare);
});

test("names the context panel after the current mode, not the Chat glyph", () => {
  render(<SidebarStub initialEntries={["/inbox"]} />);
  expect(screen.getByRole("heading", { level: 2, name: "Operate" })).toBeInTheDocument();
});

test("drops the placeholder overflow menus from the sidebar and top bar", () => {
  render(<ShellStub initialEntries={["/inbox"]} />);
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  expect(screen.queryByRole("button", { name: "Chat options" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Page options" })).not.toBeInTheDocument();
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
  for (const label of [
    "Secrets",
    "Security",
    "LLM",
    "Observability",
    "Soul",
    "Activities",
    "Memory",
    "About",
  ]) {
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(screen.getByRole("link", { name: "Design guide" })).toHaveAttribute(
    "href",
    "/design-guide"
  );
});

test("renders recent chats and highlights the active Chat", () => {
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
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
    activeChatId: "c1",
    activeChatTitle: "Inventory planning",
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
  useConversations.mockReturnValue({ ...CONVERSATIONS, startNewChat });
  render(<SidebarStub initialEntries={["/"]} />);
  await user.click(screen.getByRole("button", { name: "New chat" }));
  expect(startNewChat).toHaveBeenCalledTimes(1);
});

test("renders the shared top bar and restores focus after Escape closes navigation", async () => {
  const user = userEvent.setup();
  render(<ShellStub initialEntries={["/resources"]} />);
  expect(screen.getAllByText("Resources")).toHaveLength(2);
  expect(screen.getByText("Page content")).toBeInTheDocument();
  expect(screen.queryByText("Standard")).not.toBeInTheDocument();
  expect(screen.queryByText("TulipFarm")).not.toBeInTheDocument();

  const opener = screen.getByRole("button", { name: "Open navigation" });
  await user.click(opener);
  expect(opener).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");
  expect(opener).toHaveAttribute("aria-expanded", "false");
  expect(opener).toHaveFocus();
});

test("trails the top-bar page behind a link back to its product mode", () => {
  render(<ShellStub initialEntries={["/runs/run-1"]} />);
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).getByRole("link", { name: "Operate" })).toHaveAttribute(
    "href",
    "/inbox"
  );
  expect(within(breadcrumb).getByText("Runs")).toHaveAttribute("aria-current", "page");
});

test("omits the parent crumb when it would only repeat the page", () => {
  render(<ShellStub initialEntries={["/knowledge/spaces/ops"]} />);
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).queryByRole("link")).not.toBeInTheDocument();
  expect(within(breadcrumb).getByText("Knowledge")).toHaveAttribute("aria-current", "page");
});

test("names the chat itself in the top bar, with no self-referential parent crumb", () => {
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).queryByRole("link")).not.toBeInTheDocument();
  expect(within(breadcrumb).getByText("Q3 pricing review")).toHaveAttribute("aria-current", "page");
});

test("calls an untitled chat surface a new chat", () => {
  render(<ShellStub initialEntries={["/"]} />);
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(breadcrumb).queryByRole("link")).not.toBeInTheDocument();
  expect(within(breadcrumb).getByText("New chat")).toBeInTheDocument();
});

test("reduces the signed-in account to a monogram in the top bar", () => {
  render(<AccountShellStub initialEntries={["/inbox"]} />);
  const account = screen.getByRole("link", {
    name: "Account settings for priya.nair@northgate.dev",
  });
  expect(account).toHaveAttribute("href", "/settings/security");
  expect(account).toHaveTextContent("PN");
  expect(screen.queryByText("priya.nair@northgate.dev")).not.toBeInTheDocument();
});
