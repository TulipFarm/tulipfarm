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

const fakeEditor = {
  isEmpty: false,
  getJSON: () => doc,
  isActive: () => false,
  getAttributes: () => ({}),
  commands: { clearContent },
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

// The model selector reads GET /api/v1/llm-config on mount for its tooltips; stub it so the composer
// renders without a network call.
vi.mock("~/lib/settings", () => ({
  getLlmConfig: vi.fn().mockResolvedValue({
    tiers: { quick: { providers: [] }, standard: { providers: [] }, complex: { providers: [] } },
  }),
}));

// A plain single-paragraph document.
const textDoc = (t: string): PMNode => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});

beforeEach(() => {
  doc = textDoc("do it");
  clearContent.mockClear();
});

test("Model Selector sets the per-message model override on send", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<Composer onSend={onSend} />);

  await user.click(screen.getByRole("button", { name: /^Model:/ }));
  await user.click(screen.getByRole("button", { name: "complex" }));
  await user.click(screen.getByRole("button", { name: "send" }));

  expect(onSend).toHaveBeenCalledWith("do it", {
    model: "complex",
    agentId: undefined,
    skills: [],
    resources: [],
  });
  expect(clearContent).toHaveBeenCalled();
});

test("the model defaults to the active agent's tier", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<Composer onSend={onSend} defaultModel="complex" />);

  await user.click(screen.getByRole("button", { name: "send" }));

  expect(onSend).toHaveBeenCalledWith("do it", {
    model: "complex",
    agentId: undefined,
    skills: [],
    resources: [],
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

  await user.click(screen.getByRole("button", { name: "send" }));

  expect(onSend).toHaveBeenCalledWith("@GithubTriage triage with /copywriting on #tickets", {
    model: "standard",
    agentId: "GithubTriage",
    skills: ["copywriting"],
    resources: ["tickets"],
  });
});

test("the composer exposes no file-attachment affordance", () => {
  const { container } = render(<Composer onSend={vi.fn()} />);
  expect(container.querySelector('input[type="file"]')).toBeNull();
  expect(screen.queryByLabelText(/attach|upload|file/i)).toBeNull();
});
