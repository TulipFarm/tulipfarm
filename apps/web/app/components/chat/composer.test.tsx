import { fireEvent, render, screen } from "@testing-library/react";
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

// The upload transport is mocked, not the staging logic: these tests are about what the composer
// does with an upload's outcome, and a real XHR has none under jsdom.
const cancelUpload = vi.fn();
const uploadFile = vi.hoisted(() => vi.fn());
vi.mock("~/lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/files")>()),
  uploadFile: (...args: unknown[]) => uploadFile(...args),
}));

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
  cancelUpload.mockClear();
  uploadFile.mockReset();
  uploadFile.mockImplementation((file: File) => ({
    done: Promise.resolve({
      id: "file-1",
      filename: file.name,
      mediaType: file.type,
      sizeBytes: file.size,
      createdAt: "2024-01-01T00:00:00.000Z",
    }),
    cancel: cancelUpload,
  }));
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
    files: [],
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
    files: [],
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
    files: [],
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
    files: [],
  });
});

test("the composer offers an attach control that accepts only supported types", () => {
  const { container } = render(<Composer onSend={vi.fn()} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  expect(input.multiple).toBe(true);
  // The picker filters to the same allowlist the server enforces, so a refusal is rare and
  // legible rather than a surprise after a full upload.
  expect(input.accept).toContain("image/png");
  expect(input.accept).toContain("application/pdf");
  expect(input.accept).not.toContain("image/svg+xml");
  expect(screen.getByLabelText("Attach file")).toBeTruthy();
});

test("choosing a file shows a removable chip and sends its id once uploaded", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  doc = textDoc("what is this?");
  const { container } = render(<Composer onSend={onSend} />);

  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, new File(["png-bytes"], "shot.png", { type: "image/png" }));

  expect(await screen.findByText("shot.png")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Send prompt" }));

  expect(onSend).toHaveBeenCalledWith(
    "what is this?",
    expect.objectContaining({
      files: [{ fileId: "file-1", mediaType: "image/png", name: "shot.png" }],
    })
  );
});

test("an attachment with no text is a message in its own right", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  doc = textDoc("");
  const { container } = render(<Composer onSend={onSend} />);

  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, new File(["png"], "shot.png", { type: "image/png" }));
  await screen.findByText("shot.png");
  await user.click(screen.getByRole("button", { name: "Send prompt" }));

  expect(onSend).toHaveBeenCalledWith(
    "",
    expect.objectContaining({
      files: [{ fileId: "file-1", mediaType: "image/png", name: "shot.png" }],
    })
  );
});

test("an empty message with nothing attached still does not send", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  doc = textDoc("");
  render(<Composer onSend={onSend} />);

  await user.click(screen.getByRole("button", { name: "Send prompt" }));
  expect(onSend).not.toHaveBeenCalled();
});

test("an over-sized file is refused in the browser, before any request", async () => {
  const user = userEvent.setup();
  const { container } = render(<Composer onSend={vi.fn()} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;

  const huge = new File(["x"], "huge.png", { type: "image/png" });
  Object.defineProperty(huge, "size", { value: 26 * 1024 * 1024 });
  await user.upload(input, huge);

  expect(await screen.findByText(/larger than 25 MB/)).toBeTruthy();
  expect(uploadFile).not.toHaveBeenCalled();
});

test("removing a chip mid-upload cancels the request", async () => {
  const user = userEvent.setup();
  // Never resolves: the point is what happens while bytes are still going out.
  uploadFile.mockReturnValue({ done: new Promise(() => {}), cancel: cancelUpload });
  const { container } = render(<Composer onSend={vi.fn()} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, new File(["b"], "shot.png", { type: "image/png" }));

  await user.click(await screen.findByLabelText("Cancel upload of shot.png"));
  expect(cancelUpload).toHaveBeenCalled();
  expect(screen.queryByText("shot.png")).toBeNull();
});

test("a message will not send while an upload is still in flight", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  uploadFile.mockReturnValue({ done: new Promise(() => {}), cancel: cancelUpload });
  const { container } = render(<Composer onSend={onSend} />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, new File(["b"], "shot.png", { type: "image/png" }));

  await user.click(screen.getByRole("button", { name: "Send prompt" }));
  expect(onSend).not.toHaveBeenCalled();
});

test("dropping a file onto the composer stages and uploads it, same as the file picker", async () => {
  const onSend = vi.fn();
  doc = textDoc("what is this?");
  const { container } = render(<Composer onSend={onSend} />);

  const dropZone = container.querySelector(".rounded-lg.border") as HTMLElement;
  expect(dropZone).not.toBeNull();
  const file = new File(["png-bytes"], "dropped.png", { type: "image/png" });

  fireEvent.dragOver(dropZone);
  fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

  expect(await screen.findByText("dropped.png")).toBeTruthy();
  expect(uploadFile).toHaveBeenCalledWith(file, expect.any(Function));
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
