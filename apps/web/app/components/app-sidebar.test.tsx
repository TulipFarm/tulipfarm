import { createRemixStub } from "@remix-run/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { AppShell, AppSidebar, iconForPath, titleForPath } from "~/components/app-sidebar";
import { BookOpen, Inbox, MessageSquare } from "~/components/icons";
import * as approvalsContext from "~/lib/approvals-context";
import * as conversationsContext from "~/lib/conversations-context";
import * as sidebarCounts from "~/lib/sidebar-counts";

vi.mock("~/lib/approvals-context", () => ({ useApprovals: vi.fn() }));
const useApprovals = vi.mocked(approvalsContext.useApprovals);

vi.mock("~/lib/conversations-context", () => ({ useConversations: vi.fn() }));
const useConversations = vi.mocked(conversationsContext.useConversations);

vi.mock("~/lib/sidebar-counts", () => ({ useSidebarCounts: vi.fn() }));
const useSidebarCounts = vi.mocked(sidebarCounts.useSidebarCounts);

const USER = {
  id: "u1",
  email: "priya.nair@northgate.dev",
  name: null,
  role: "admin" as const,
  status: "active" as const,
  navigation: { visiblePaths: [] },
};

const SidebarStub = createRemixStub([{ path: "*", Component: AppSidebar }]);
const AccountSidebarStub = createRemixStub([
  { path: "*", Component: () => <AppSidebar user={USER} /> },
]);
const RestrictedSidebarStub = createRemixStub([
  {
    path: "*",
    Component: () => (
      <AppSidebar
        user={{ ...USER, navigation: { visiblePaths: ["/resources", "/business/activities"] } }}
      />
    ),
  },
]);
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
  renameChat: vi.fn(),
  removeChat: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.sidebar;
  useApprovals.mockReturnValue({
    approvals: [],
    count: 0,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  useConversations.mockReturnValue(CONVERSATIONS);
  useSidebarCounts.mockReturnValue({});
});

test("maps deep routes to stable top-bar titles", () => {
  expect(titleForPath("/resources/tickets")).toBe("Resources");
  expect(titleForPath("/operations")).toBe("Operations");
  expect(titleForPath("/settings/instructions")).toBe("Custom instructions");
});

test("gives every page its own top-bar icon instead of the Chat glyph", () => {
  expect(iconForPath("/inbox")).toBe(Inbox);
  expect(iconForPath("/knowledge/spaces/ops")).toBe(BookOpen);
  expect(iconForPath("/chat/c1")).toBe(MessageSquare);
});

/*
 * The point of the redesign: one list, no rail, no second panel to open. If a rail or a mode
 * switcher comes back, a reader is once again two clicks from a destination they can already see.
 */
test("renders every destination in one flat list, with no rail or second panel", () => {
  render(<SidebarStub initialEntries={["/inbox"]} />);
  const nav = screen.getByRole("navigation", { name: "Main" });

  for (const heading of ["Work", "Build"]) {
    expect(within(nav).getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
  }
  for (const label of ["Chats", "Inbox", "Activity", "Resources", "Agents", "Knowledge"]) {
    expect(within(nav).getByRole("link", { name: new RegExp(label, "i") })).toBeInTheDocument();
  }
  const utilities = screen.getByRole("navigation", { name: "Utilities" });
  expect(within(utilities).getByRole("link", { name: "Farm" })).toBeInTheDocument();
  expect(within(utilities).getByRole("link", { name: "Settings" })).toBeInTheDocument();

  expect(screen.queryByRole("navigation", { name: "Product modes" })).not.toBeInTheDocument();
  expect(within(nav).queryByRole("heading", { name: "Knowledge" })).not.toBeInTheDocument();
});

test("marks the destination matching the current page, and only that one", () => {
  render(<SidebarStub initialEntries={["/agents"]} />);
  const nav = screen.getByRole("navigation", { name: "Main" });

  expect(
    within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.textContent)
  ).toEqual(["Agents"]);
});

test("shows pending feedback on a nav row while its destination is still loading", async () => {
  const PendingSidebarStub = createRemixStub([
    { path: "/chats", Component: AppSidebar },
    {
      path: "/routines",
      Component: AppSidebar,
      // Never resolves, so the row stays in the pending state for the assertion below.
      loader: () => new Promise(() => {}),
    },
  ]);
  render(<PendingSidebarStub initialEntries={["/chats"]} />);
  const nav = screen.getByRole("navigation", { name: "Main" });
  const routinesLink = within(nav).getByRole("link", { name: /Routines/i });

  expect(routinesLink.className).not.toMatch(/animate-pulse/);
  await userEvent.click(routinesLink);
  expect(routinesLink.className).toMatch(/animate-pulse/);
});

test("carries the live approval count on Inbox", () => {
  useApprovals.mockReturnValue({
    approvals: [],
    count: 2,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  render(<SidebarStub initialEntries={["/inbox"]} />);

  expect(within(screen.getByRole("link", { name: /inbox/i })).getByText("2")).toBeInTheDocument();
});

test("aligns every expanded count on the same trailing slot", () => {
  useSidebarCounts.mockReturnValue({ "/resources": 1, "/skills": 7 });
  render(<SidebarStub initialEntries={["/skills"]} />);

  const counts = screen.getAllByText(/^[17]$/);
  expect(counts).toHaveLength(2);
  for (const count of counts) {
    expect(count).toHaveAttribute("data-sidebar-count");
    expect(count).toHaveClass("ms-auto", "w-5", "text-right", "leading-none");
  }
});

/* Collapsed, the count shrinks to a dot — so the row's own label has to carry the number. */
test("still announces the approval count when the sidebar is collapsed", async () => {
  const user = userEvent.setup();
  useApprovals.mockReturnValue({
    approvals: [],
    count: 2,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  render(<ShellStub initialEntries={["/inbox"]} />);

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("link", { name: "Inbox, 2 awaiting you" })).toBeInTheDocument();
});

test("hides denied destinations and the groups they empty", () => {
  render(<RestrictedSidebarStub initialEntries={["/business/activities"]} />);
  const nav = screen.getByRole("navigation", { name: "Main" });

  expect(within(nav).getByRole("link", { name: "Activity" })).toBeInTheDocument();
  expect(within(nav).getByRole("link", { name: "Resources" })).toBeInTheDocument();
  for (const label of ["Inbox", "Farm", "Knowledge"]) {
    expect(within(nav).queryByRole("link", { name: label })).not.toBeInTheDocument();
  }
  expect(within(nav).queryByRole("heading", { name: "Build" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
});

test("replaces the app destinations with Settings navigation on a Settings-owned route", () => {
  render(<SidebarStub initialEntries={["/business/models"]} />);
  const nav = screen.getByRole("navigation", { name: "Settings" });

  for (const heading of ["You", "Business", "Operate", "Developer"]) {
    expect(within(nav).getByRole("heading", { name: heading })).toBeInTheDocument();
  }
  expect(within(nav).getByRole("link", { name: "Models" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Back to app" })).toHaveAttribute("href", "/");
  expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Utilities" })).not.toBeInTheDocument();
});

test("keeps operator destinations inside the same Settings navigation", () => {
  render(<SidebarStub initialEntries={["/operations"]} />);
  const nav = screen.getByRole("navigation", { name: "Settings" });

  for (const label of ["Operations", "Observability"]) {
    expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
  }
});

test("filters Settings destinations without leaving the current page", async () => {
  const user = userEvent.setup();
  render(<SidebarStub initialEntries={["/settings/profile"]} />);

  await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "model");

  const nav = screen.getByRole("navigation", { name: "Settings" });
  expect(within(nav).getByRole("link", { name: "Models" })).toBeInTheDocument();
  expect(within(nav).queryByRole("link", { name: "Profile" })).not.toBeInTheDocument();
});

test("keeps a nested Settings page attached to its parent destination", () => {
  render(<SidebarStub initialEntries={["/business/access/teams"]} />);

  expect(screen.getByRole("link", { name: "People & access" })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

test("renders recent chats and highlights the active one", () => {
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
  render(<SidebarStub initialEntries={["/chat/c1"]} />);

  expect(screen.getByRole("link", { name: "Inventory planning" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute("href", "/chat/c2");
  expect(screen.getAllByRole("button", { name: "Chat actions" })[0]).toHaveClass("size-7");
});

/* Three group headings, one behaviour: the word is the disclosure, in every group. */
test("collapses every group by its own heading, Recent included", async () => {
  const user = userEvent.setup();
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    conversations: [
      {
        id: "c1",
        title: "Inventory planning",
        agentId: null,
        starred: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
  render(<SidebarStub initialEntries={["/chats"]} />);

  for (const heading of ["Work", "Build", "Recent"]) {
    const button = within(screen.getByRole("heading", { level: 2, name: heading })).getByRole(
      "button"
    );
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.click(button);
    expect(
      within(screen.getByRole("heading", { level: 2, name: heading })).getByRole("button")
    ).toHaveAttribute("aria-expanded", "false");
  }

  expect(screen.queryByRole("link", { name: "Inbox" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Agents" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Inventory planning" })).not.toBeInTheDocument();
});

test("starts a fresh Chat from the sidebar", async () => {
  const user = userEvent.setup();
  const startNewChat = vi.fn();
  useConversations.mockReturnValue({ ...CONVERSATIONS, startNewChat });
  render(<SidebarStub initialEntries={["/inbox"]} />);

  await user.click(screen.getByRole("button", { name: "New chat" }));
  expect(startNewChat).toHaveBeenCalledTimes(1);
});

test("renames a recent chat from the sidebar without following its link", async () => {
  const user = userEvent.setup();
  const renameChat = vi.fn(async () => CONVERSATIONS.conversations[0]);
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
    ],
    renameChat,
  });
  render(<SidebarStub initialEntries={["/"]} />);
  await user.click(screen.getByRole("button", { name: "Chat actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /rename/i }));

  const input = screen.getByLabelText("Rename chat");
  await user.clear(input);
  await user.type(input, "Q3 restock{Enter}");
  expect(renameChat).toHaveBeenCalledWith("c1", "Q3 restock");
});

test("deletes a recent chat from the sidebar only after confirmation", async () => {
  const user = userEvent.setup();
  const removeChat = vi.fn(async () => {});
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
    ],
    removeChat,
  });
  render(<SidebarStub initialEntries={["/"]} />);
  await user.click(screen.getByRole("button", { name: "Chat actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
  expect(removeChat).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: /^delete$/i }));
  expect(removeChat).toHaveBeenCalledWith("c1");
});

/* Sign-out and the theme lost their rail, so the account menu is now the only way to reach them. */
test("names the signed-in account and keeps sign-out reachable from its menu", async () => {
  const user = userEvent.setup();
  render(<AccountSidebarStub initialEntries={["/inbox"]} />);

  expect(screen.getByText("priya.nair@northgate.dev")).toBeInTheDocument();
  const trigger = screen.getByRole("button", {
    name: "Account menu for priya.nair@northgate.dev",
  });
  expect(trigger).toHaveTextContent("PN");
  expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
    "href",
    "/settings/profile"
  );
});

test("closes the account menu on Escape and returns focus to its trigger", async () => {
  const user = userEvent.setup();
  render(<AccountSidebarStub initialEntries={["/inbox"]} />);
  const trigger = screen.getByRole("button", {
    name: "Account menu for priya.nair@northgate.dev",
  });

  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();
});

/*
 * Collapsing keeps every destination reachable — it trades the label for a tooltip, it does not
 * remove the row. A collapsed sidebar that hides destinations is just a broken sidebar.
 */
test("collapses to icons without losing a destination, and persists the choice", async () => {
  const user = userEvent.setup();
  render(<ShellStub initialEntries={["/inbox"]} />);

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  const nav = screen.getByRole("navigation", { name: "Main" });

  for (const label of ["Chats", "Inbox", "Resources", "Agents"]) {
    expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
  }
  expect(
    within(screen.getByRole("navigation", { name: "Utilities" })).getByRole("link", {
      name: "Farm",
    })
  ).toBeInTheDocument();
  expect(within(nav).queryByRole("heading", { name: "Work" })).not.toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Application navigation" }).className).toContain(
    "lg:w-14"
  );
  expect(localStorage.getItem("sidebar-collapsed")).toBe("true");
  expect(document.documentElement.dataset.sidebar).toBe("collapsed");

  await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(localStorage.getItem("sidebar-collapsed")).toBe("false");
  expect(within(nav).getByRole("heading", { name: "Work" })).toBeInTheDocument();
});

/* The skeleton in index.html reads [data-sidebar], so the shell must adopt it on first render. */
test("opens already collapsed when that is the persisted choice", () => {
  document.documentElement.dataset.sidebar = "collapsed";
  render(<ShellStub initialEntries={["/inbox"]} />);

  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  expect(screen.getByRole("complementary", { name: "Application navigation" }).className).toContain(
    "lg:w-14"
  );
});

test("keeps the sidebar off-canvas on mobile instead of pinning it over the page", () => {
  render(<ShellStub initialEntries={["/farm"]} />);
  const aside = screen.getByRole("complementary", { name: "Application navigation" });

  expect(aside.className).toContain("-translate-x-full");
  expect(aside.className).toContain("lg:translate-x-0");
});

test("renders the shared top bar and restores focus after Escape closes navigation", async () => {
  const user = userEvent.setup();
  render(<ShellStub initialEntries={["/resources"]} />);
  expect(screen.getAllByText("Resources")).toHaveLength(2);
  expect(screen.getByText("Page content")).toBeInTheDocument();
  expect(screen.getAllByRole("main")).toHaveLength(1);
  const main = screen.getByRole("main");
  expect(main).toHaveAttribute("id", "main-content");
  expect(main.parentElement).toHaveClass("lg:rounded-lg", "lg:border");
  expect(screen.getByRole("complementary", { name: "Application navigation" })).not.toHaveClass(
    "border-r"
  );

  const opener = screen.getByRole("button", { name: "Open navigation" });
  await user.click(opener);
  expect(opener).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Escape}");
  expect(opener).toHaveAttribute("aria-expanded", "false");
  expect(opener).toHaveFocus();
});

test("names the chat itself in the top bar", () => {
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);

  expect(screen.getByText("Q3 pricing review")).toHaveAttribute("aria-current", "page");
});

test("renames the open chat by clicking its name in the top bar", async () => {
  const user = userEvent.setup();
  const renameChat = vi.fn(async () => CONVERSATIONS.conversations[0]);
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
    renameChat,
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  await user.click(screen.getByRole("button", { name: "Rename this chat: Q3 pricing review" }));

  const input = screen.getByLabelText("Rename this chat");
  expect(input).toHaveAttribute("maxlength", "200");
  await user.clear(input);
  await user.type(input, "Q3 pricing, final{Enter}");
  expect(renameChat).toHaveBeenCalledWith("c1", "Q3 pricing, final");
});

test("deletes the open chat from the top bar only after confirmation", async () => {
  const user = userEvent.setup();
  const removeChat = vi.fn(async () => {});
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
    removeChat,
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  await user.click(screen.getByRole("button", { name: "Chat actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
  expect(removeChat).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: /^delete$/i }));
  expect(removeChat).toHaveBeenCalledWith("c1");
});

test("offers no rename or delete on the new-chat surface, which has nothing to act on", () => {
  render(<ShellStub initialEntries={["/"]} />);
  expect(screen.queryByRole("button", { name: "Chat actions" })).not.toBeInTheDocument();
});

test("keeps the chat actions reachable on touch, where there is no hover to reveal them", () => {
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  const trigger = screen.getByRole("button", { name: "Chat actions" });
  // Hidden only from `sm` up: below it the trigger stays visible at a 44px target.
  expect(trigger.className).toContain("sm:opacity-0");
  expect(trigger.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
  expect(trigger.className).toContain("size-11");
});

test("keeps a refused delete inside its dialog, where the backdrop cannot hide it", async () => {
  const user = userEvent.setup();
  const removeChat = vi.fn(async () => {
    throw new Error("This chat has a Turn in progress.");
  });
  useConversations.mockReturnValue({
    ...CONVERSATIONS,
    activeChatId: "c1",
    activeChatTitle: "Q3 pricing review",
    removeChat,
  });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  await user.click(screen.getByRole("button", { name: "Chat actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
  await user.click(screen.getByRole("button", { name: /^delete$/i }));

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("alert")).toHaveTextContent("This chat has a Turn in progress.");
  // The dialog stays open so the user can read the reason and retry or cancel.
  expect(within(dialog).getByRole("button", { name: /^delete$/i })).toBeEnabled();
});

test("does not seed the rename field with the placeholder shown before the titler lands", async () => {
  const user = userEvent.setup();
  useConversations.mockReturnValue({ ...CONVERSATIONS, activeChatId: "c1", activeChatTitle: null });
  render(<ShellStub initialEntries={["/chat/c1"]} />);
  await user.click(screen.getByRole("button", { name: "Rename this chat: New chat" }));
  expect(screen.getByLabelText("Rename this chat")).toHaveValue("");
});

test("calls an untitled chat surface a new chat", () => {
  render(<ShellStub initialEntries={["/"]} />);

  expect(screen.getByText("New chat", { selector: "span[aria-current]" })).toBeInTheDocument();
});

test("renders the report a bug button in the top bar", () => {
  render(<ShellStub initialEntries={["/inbox"]} />);
  expect(screen.getByRole("button", { name: "Report a bug" })).toBeInTheDocument();
});

/*
 * Two treatments were tried and rejected before this one.
 *
 * A filled ruby band read as an error banner: a saturated fill at row size is the same signal the
 * destructive tone uses. Brand *ink* on a neutral ground was tried next, and on a sidebar this
 * quiet it became the loudest thing on the screen — the row was shouting a fact the reader
 * already knew.
 *
 * Selection is now carried by ground and weight alone, with no colour at all. Colour in this
 * system marks what a reader can act on; the row they are already on is not that.
 */
test("marks the active destination with weight on a neutral ground, never colour", () => {
  render(<SidebarStub initialEntries={["/agents"]} />);

  const active = screen.getByRole("link", { name: "Agents" });
  const idle = screen.getByRole("link", { name: "Skills" });

  expect(active).toHaveAttribute("aria-current", "page");
  expect(active.className).toContain("font-medium");
  expect(active.className).toContain("bg-sidebar-accent");
  expect(active.className).toContain("text-sidebar-accent-foreground");
  // No brand colour, as ink or as ground: both reads were rejected above.
  expect(active.className).not.toContain("text-brand");
  expect(active.className).not.toContain("bg-brand");
  expect(active.className).not.toContain("bg-sidebar-primary");

  expect(idle.className).not.toContain("text-brand");
  expect(idle.className).toContain("hover:bg-sidebar-accent");
  expect(idle.className).not.toContain("hover:bg-sidebar-accent/");
});

test("gives every row the same box model as the bordered New chat button", () => {
  render(<SidebarStub initialEntries={["/agents"]} />);

  for (const name of ["Agents", "Skills", "Inbox"]) {
    expect(screen.getByRole("link", { name }).className).toContain("border border-transparent");
  }
});

/* A closed group is a preference, so it has to survive the next render of the sidebar. */
test("closes a group, hides its rows, and remembers the choice", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<SidebarStub initialEntries={["/agents"]} />);

  expect(screen.getByRole("link", { name: "Agents" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Build" }));
  expect(screen.queryByRole("link", { name: "Agents" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: "Build" })).toBeInTheDocument();

  unmount();
  render(<SidebarStub initialEntries={["/agents"]} />);
  expect(screen.queryByRole("link", { name: "Agents" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Build" })).toHaveAttribute("aria-expanded", "false");
});

/* A `+` that opens nothing teaches a reader to distrust every other `+`. */
test("offers quick create only on the rows that own a create route", () => {
  render(<SidebarStub initialEntries={["/agents"]} />);

  expect(screen.getByRole("link", { name: "New resource type" })).toHaveAttribute(
    "href",
    "/resources/new"
  );
  expect(screen.getByRole("link", { name: "New space" })).toHaveAttribute(
    "href",
    "/knowledge/spaces/new"
  );
  for (const label of ["New agent", "New skill", "New routine"]) {
    expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
  }
});

test("reads the approval count as a quiet numeral rather than a pill", () => {
  useApprovals.mockReturnValue({
    approvals: [],
    count: 3,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  render(<SidebarStub initialEntries={["/inbox"]} />);

  const row = screen.getByRole("link", { name: /Inbox\s*3\s*awaiting you/ });
  const numeral = within(row).getByText("3");
  expect(numeral.className).toContain("text-status-danger");
  expect(numeral.className).not.toContain("border");
});

test("opens the command menu with / and reaches a destination through it", async () => {
  const user = userEvent.setup();
  render(<SidebarStub initialEntries={["/agents"]} />);

  await user.keyboard("/");
  const dialog = screen.getByRole("dialog", { name: "Command menu" });
  await user.type(within(dialog).getByRole("combobox"), "routi");

  expect(within(dialog).getByRole("button", { name: /Routines/ })).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: /Agents/ })).not.toBeInTheDocument();
});

test("keeps / for the page when the reader is already typing", async () => {
  const user = userEvent.setup();
  render(
    <>
      <input aria-label="Composer" />
      <SidebarStub initialEntries={["/agents"]} />
    </>
  );

  await user.click(screen.getByLabelText("Composer"));
  await user.keyboard("/");
  expect(screen.queryByRole("dialog", { name: "Command menu" })).not.toBeInTheDocument();
});

/* Two controls claiming the same job is one control too many. */
test("shows one collapse control at a time, moving it out of the sidebar when it narrows", async () => {
  const user = userEvent.setup();
  render(<ShellStub initialEntries={["/agents"]} />);

  expect(screen.getAllByRole("button", { name: "Collapse sidebar" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Expand sidebar" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getAllByRole("button", { name: "Expand sidebar" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
});

/*
 * The sidebar is a transformed element, which makes it the containing block for anything
 * `position: fixed` inside it. Rendered in place the palette was trapped at 248px, so it has to
 * leave the aside entirely.
 */
test("escapes the transformed sidebar by portalling the command menu to the body", async () => {
  const user = userEvent.setup();
  render(<SidebarStub initialEntries={["/agents"]} />);

  await user.keyboard("{Meta>}k{/Meta}");
  const dialog = screen.getByRole("dialog", { name: "Command menu" });
  expect(screen.getByRole("navigation", { name: "Main" }).contains(dialog)).toBe(false);
  expect(document.body.contains(dialog)).toBe(true);
});

test("leads the command menu with what a reader can do, not only where they can go", async () => {
  const user = userEvent.setup();
  render(<SidebarStub initialEntries={["/agents"]} />);

  await user.keyboard("{Control>}k{/Control}");
  const dialog = screen.getByRole("dialog", { name: "Command menu" });
  const options = within(dialog).getAllByRole("button");

  expect(options[0]).toHaveAccessibleName(/New chat/);
  expect(within(dialog).getByRole("button", { name: /New resource type/ })).toBeInTheDocument();
  expect(within(dialog).getByText("Actions")).toBeInTheDocument();
});

/* A section total is furniture; only something waiting on the reader earns the alarm colour. */
test("tells a section total apart from something waiting on the reader", () => {
  useApprovals.mockReturnValue({
    approvals: [],
    count: 2,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  useSidebarCounts.mockReturnValue({ "/agents": 7 });
  render(<SidebarStub initialEntries={["/agents"]} />);

  const quiet = within(screen.getByRole("link", { name: /Agents/ })).getByText("7");
  expect(quiet.className).toContain("text-muted-foreground");

  const alert = within(screen.getByRole("link", { name: /awaiting you/ })).getByText("2");
  expect(alert.className).toContain("text-status-danger");
});

/* A source that cannot answer for the whole set is absent, never rendered as zero. */
test("says nothing at all for a section whose total is unknown", () => {
  useSidebarCounts.mockReturnValue({ "/agents": 7 });
  render(<SidebarStub initialEntries={["/agents"]} />);

  expect(screen.getByRole("link", { name: "Skills" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Routines" })).toBeInTheDocument();
});
