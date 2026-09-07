import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { PMNode } from "~/components/chat/editor/serialize";
import { OnboardingCompanion } from "~/components/onboarding/companion";
import { CompanionProvider } from "~/lib/companion-context";
import type { Task } from "~/lib/tasks";
import ChatRoute from "~/routes/_app._index";

/*
 * Regression for #732: clicking a Companion "chat"-action Task while already on "/" used to
 * `navigate("/?draft=...")`, then the route's own `history.replaceState` cleanup desynced the
 * Remix router's tracked location from the address bar, silently dropping every navigation after
 * it. The fix drafts the prompt through `CompanionProvider`'s shared state instead of the URL, so
 * this exercises the full FAB → Task → composer path end to end rather than the route in isolation.
 *
 * ProseMirror's contenteditable can't be driven under jsdom (see composer-editor.test.tsx), so
 * Tiptap is mocked the same way here: `useEditor` returns a fake whose `commands.setContent` is a
 * spy, which is what `draftSuggestion` calls to seed the composer.
 */
let doc: PMNode;
const setContent = vi.fn();
const selectTextblockEnd = vi.fn();
const insertContent = vi.fn();
const viewFocus = vi.fn();

const fakeEditor = {
  isEmpty: false,
  getJSON: () => doc,
  isActive: () => false,
  getAttributes: () => ({}),
  commands: { clearContent: vi.fn(), setContent, selectTextblockEnd, insertContent },
  view: { focus: viewFocus },
  chain: () => ({ focus: () => ({ run: () => true }) }),
};

vi.mock("@tiptap/react", () => ({
  useEditor: () => fakeEditor,
  EditorContent: () => <div />,
  useEditorState: ({ selector }: { selector: (ctx: { editor: typeof fakeEditor }) => unknown }) =>
    selector({ editor: fakeEditor }),
}));
vi.mock("@tiptap/react/menus", () => ({ BubbleMenu: () => null }));
vi.mock("@tiptap/starter-kit", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-placeholder", () => ({ default: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-link", () => ({
  default: {
    extend: () => ({ configure: () => ({}) }),
  },
}));
vi.mock("~/components/chat/editor/mentions", () => ({
  buildMentionExtensions: () => [],
  MENTION_PLUGIN_KEYS: [],
}));
vi.mock("~/components/chat/editor/use-mention-data", () => ({ useMentionData: () => () => [] }));

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return { ...actual, useLoaderData: vi.fn() };
});

vi.mock("~/lib/onboarding", () => ({ listOnboardingSuggestions: vi.fn() }));
vi.mock("~/lib/tasks", () => ({
  listTasks: vi.fn(),
  dismissTask: vi.fn(),
  completeTask: vi.fn(),
  answerTask: vi.fn(),
}));

import { listOnboardingSuggestions } from "~/lib/onboarding";
import { listTasks } from "~/lib/tasks";

Element.prototype.scrollIntoView = vi.fn();

const CHAT_TASK: Task = {
  id: "t1",
  title: "Add your business description",
  action: { kind: "chat", prompt: "Help me describe my business." },
  blocking: false,
  status: "open",
  createdAt: "2026-01-01T00:00:00Z",
};

function App() {
  return (
    <CompanionProvider>
      <OnboardingCompanion />
      <ChatRoute />
    </CompanionProvider>
  );
}

const Stub = createRemixStub([{ path: "/", Component: App }]);

beforeEach(() => {
  doc = { type: "doc", content: [] };
  setContent.mockClear();
  selectTextblockEnd.mockClear();
  viewFocus.mockClear();
  vi.mocked(listOnboardingSuggestions).mockResolvedValue([]);
  vi.mocked(listTasks).mockResolvedValue([CHAT_TASK]);
  vi.mocked(remix.useLoaderData).mockReturnValue({ agentId: undefined, defaultModel: "auto" });
});

test("clicking a Companion 'Ask in chat' Task drafts its prompt into the composer", async () => {
  const user = userEvent.setup();
  render(<Stub initialEntries={["/"]} />);

  await user.click(
    await screen.findByRole("button", { name: "Onboarding companion, 1 suggestion" })
  );
  await user.click(await screen.findByRole("button", { name: "Ask in chat" }));

  await waitFor(() => expect(setContent).toHaveBeenCalledWith("Help me describe my business."));
});

test("clicking the same Task card twice redrafts it both times, not just the first", async () => {
  const user = userEvent.setup();
  render(<Stub initialEntries={["/"]} />);

  await user.click(
    await screen.findByRole("button", { name: "Onboarding companion, 1 suggestion" })
  );
  await user.click(await screen.findByRole("button", { name: "Ask in chat" }));
  await waitFor(() => expect(setContent).toHaveBeenCalledTimes(1));

  setContent.mockClear();

  // The panel closes itself on pick — reopen it to click the same card a second time. The Task
  // itself is never removed: a "chat" action never calls onAnswered/dismiss.
  await user.click(
    await screen.findByRole("button", { name: "Onboarding companion, 1 suggestion" })
  );
  await user.click(await screen.findByRole("button", { name: "Ask in chat" }));

  // Before the fix this second call never reached the editor: the composer's own `draftedRef`
  // dedupes on identical prompt *text*, and the Companion had no nonce to key on instead.
  await waitFor(() => expect(setContent).toHaveBeenCalledTimes(1));
  expect(setContent).toHaveBeenCalledWith("Help me describe my business.");
});
