import { act, render, screen, waitFor } from "@testing-library/react";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryFile } from "~/lib/files";
import type { SearchResponse } from "~/lib/knowledge-api";
import { buildMentionExtensions } from "./mentions";
import type { MentionItem } from "./serialize";
import type { GetItems } from "./use-mention-data";

const searchKnowledge = vi.hoisted(() => vi.fn());
vi.mock("~/lib/knowledge-api", () => ({ searchKnowledge }));
const searchFiles = vi.hoisted(() => vi.fn());
vi.mock("~/lib/files", () => ({ searchFiles }));

const AGENTS: MentionItem[] = [{ id: "atlas", label: "Atlas", description: "Ops agent" }];
const withAgents: GetItems = (kind) => (kind === "agent" ? AGENTS : []);
const withNothing: GetItems = () => [];

function Harness({ getItems, onReady }: { getItems: GetItems; onReady: (e: Editor) => void }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit.configure({ heading: false }), ...buildMentionExtensions(getItems)],
  });
  useEffect(() => {
    if (editor) onReady(editor);
  }, [editor, onReady]);
  return <EditorContent editor={editor} />;
}

async function mountEditor(getItems: GetItems = withAgents): Promise<Editor> {
  let editor: Editor | null = null;
  render(<Harness getItems={getItems} onReady={(e) => (editor = e)} />);
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor;
}

async function type(editor: Editor, text: string) {
  await act(async () => {
    editor.commands.insertContent(text);
    await Promise.resolve();
  });
}

function hit(pageId: string, title: string, content: string): SearchResponse["results"][number] {
  return { pageId, chunkId: `${pageId}-c1`, title, content, source: "authored", score: 0.9 };
}

beforeEach(() => {
  searchKnowledge.mockReset();
  searchKnowledge.mockResolvedValue({ results: [], warnings: [] } satisfies SearchResponse);
  searchFiles.mockReset();
  searchFiles.mockResolvedValue([]);
});

describe("Knowledge (~) mention menu", () => {
  it("renders a loading state, then the matching Knowledge pages", async () => {
    let resolveSearch: (r: SearchResponse) => void = () => {};
    searchKnowledge.mockReturnValue(
      new Promise<SearchResponse>((resolve) => {
        resolveSearch = resolve;
      })
    );

    const editor = await mountEditor();
    await type(editor, "~");
    await type(editor, "a");

    expect(await screen.findByRole("status")).toHaveTextContent("Searching Knowledge…");

    await act(async () => {
      resolveSearch({
        results: [hit("page-1", "Autonomy policy", "How much rope an agent gets")],
        warnings: [],
      });
      await Promise.resolve();
    });

    expect(await screen.findByRole("button", { name: /Autonomy policy/i })).toBeInTheDocument();
  });

  it("renders an empty state when the Knowledge search returns no hits", async () => {
    const editor = await mountEditor();
    await type(editor, "~");
    await type(editor, "zzz");

    expect(await screen.findByText("No matching Knowledge.")).toBeInTheDocument();
  });

  it("still opens the agent (@) menu", async () => {
    const editor = await mountEditor();
    await type(editor, "@");
    await type(editor, "a");

    expect(await screen.findByRole("button", { name: /Atlas/i })).toBeInTheDocument();
  });
});

describe("File (+) mention menu", () => {
  it("renders readable filename matches", async () => {
    searchFiles.mockResolvedValue([
      {
        id: "file-1",
        filename: "pricing.json",
        mediaType: "application/json",
        sizeBytes: 120,
      } satisfies Partial<LibraryFile>,
    ]);

    const editor = await mountEditor();
    await type(editor, "+");
    await type(editor, "pricing");

    expect(await screen.findByRole("button", { name: /pricing.json/i })).toBeInTheDocument();
    expect(searchFiles).toHaveBeenCalledWith("pricing", 8);
  });
});

// chat.md S4 step 6: every trigger shows an empty state when there are no matches. A fresh instance
// has no Skills and no Resource types, so `/` and `#` hit this on the operator's first session.
describe("every mention trigger shows an empty state", () => {
  it.each([
    ["@", "No matching Agents."],
    ["/", "No matching Skills."],
    ["#", "No matching Resource types."],
    ["~", "No matching Knowledge."],
    ["+", "No matching Files."],
  ])("%s renders its own empty state over an empty catalog", async (char, label) => {
    const editor = await mountEditor(withNothing);
    await type(editor, char);
    await type(editor, "zzz");

    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});
