import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { Composer } from "~/components/chat/composer";
import type { PMNode } from "~/components/chat/editor/serialize";

// ProseMirror's contenteditable can't be driven under jsdom, so the editor is mocked: `useEditor`
// returns a fake whose `getJSON()` is the controllable `doc`, and `useEditorState` runs the real
// selector against it. The composer's own wiring — serialize the doc → call `onSend` with the markdown
// text plus the resolved `@/ / /#` tags — is exercised directly. The document-shaping itself is covered
// exhaustively by `editor/serialize.test.ts`.
let doc: PMNode;
const clearContent = vi.fn();
const setContent = vi.fn();
const selectTextblockEnd = vi.fn();
const viewFocus = vi.fn();

const fakeEditor = {
  isEmpty: false,
  getJSON: () => doc,
  isActive: () => false,
  getAttributes: () => ({}),
  commands: { clearContent, setContent, selectTextblockEnd },
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
vi.mock("~/components/chat/editor/mentions", () => ({
  buildMentionExtensions: () => [],
  MENTION_PLUGIN_KEYS: [],
}));
vi.mock("~/components/chat/editor/use-mention-data", () => ({ useMentionData: () => () => [] }));

// A plain single-paragraph document.
const textDoc = (t: string): PMNode => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});

beforeEach(() => {
  doc = textDoc("do it");
  clearContent.mockClear();
  setContent.mockClear();
  selectTextblockEnd.mockClear();
  viewFocus.mockClear();
});

test("Model Selector sets the per-message effort preset override on send", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<Composer onSend={onSend} />);

  await user.click(screen.getByRole("button", { name: /^Effort preset:/ }));
  await user.click(screen.getByRole("menuitemradio", { name: /Thorough/ }));
  await user.click(screen.getByRole("button", { name: "Send prompt" }));

  expect(onSend).toHaveBeenCalledWith("do it", {
    model: "thorough",
    agentId: undefined,
    skills: [],
    resources: [],
    knowledgePages: [],
  });
  expect(clearContent).toHaveBeenCalled();
});

test("the effort preset defaults to Auto when nothing is chosen", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<Composer onSend={onSend} />);

  await user.click(screen.getByRole("button", { name: "Send prompt" }));

  expect(onSend).toHaveBeenCalledWith("do it", {
    model: "auto",
    agentId: undefined,
    skills: [],
    resources: [],
    knowledgePages: [],
  });
});

test("the effort preset can default from the active agent", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<Composer onSend={onSend} defaultModel="thorough" />);

  await user.click(screen.getByRole("button", { name: "Send prompt" }));

  expect(onSend).toHaveBeenCalledWith("do it", {
    model: "thorough",
    agentId: undefined,
    skills: [],
    resources: [],
    knowledgePages: [],
  });
});

test("send serializes mentions into agentId + skills + resources", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "mentionAgent", attrs: { id: "GithubTriage", label: "GithubTriage" } },
          { type: "text", text: " triage with " },
          { type: "mentionSkill", attrs: { id: "copywriting", label: "copywriting" } },
          { type: "text", text: " on " },
          { type: "mentionResource", attrs: { id: "tickets", label: "tickets" } },
        ],
      },
    ],
  };
  render(<Composer onSend={onSend} />);

  await user.click(screen.getByRole("button", { name: "Send prompt" }));

  expect(onSend).toHaveBeenCalledWith("@GithubTriage triage with /copywriting on #tickets", {
    model: "auto",
    agentId: "GithubTriage",
    skills: ["copywriting"],
    resources: ["tickets"],
    knowledgePages: [],
  });
});

test("the composer exposes no file-attachment affordance", () => {
  const { container } = render(<Composer onSend={vi.fn()} />);
  expect(container.querySelector('input[type="file"]')).toBeNull();
  expect(screen.queryByLabelText(/attach|upload|file/i)).toBeNull();
});

test("a Suggested prompt drafts editable text without sending", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(
    <Composer
      onSend={onSend}
      suggestions={[{ id: "plan", label: "Create a plan", prompt: "Create a practical plan." }]}
    />
  );

  await user.click(screen.getByRole("button", { name: "Create a plan" }));

  expect(setContent).toHaveBeenCalledWith("Create a practical plan.");
  expect(selectTextblockEnd).toHaveBeenCalledOnce();
  expect(viewFocus).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
});
