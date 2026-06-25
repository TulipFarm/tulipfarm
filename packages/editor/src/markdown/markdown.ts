import { type JSONContent, resolveExtensions } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import {
  type BuildExtensionsOptions,
  buildContentExtensions,
} from "../extensions/build-extensions";

/*
 * DOM-free markdown ⇄ ProseMirror-JSON bridge. Built on `@tiptap/markdown`'s `MarkdownManager`, fed
 * the same canonical content schema the React editor uses (`buildContentExtensions`), flattened via
 * `resolveExtensions` (StarterKit expands to its children; the manager expects a flat, priority-sorted
 * list). No editor/DOM is mounted, so this is unit-testable in plain node.
 *
 * Markdown is the canonical store; these helpers are the boundary. Note: serialization NORMALIZES
 * (bullet markers, emphasis chars, table padding) — the first round-trip rewrites a body to its
 * canonical form, which is then stable (idempotent).
 */

let cached: MarkdownManager | null = null;

function manager(): MarkdownManager {
  if (!cached) {
    cached = new MarkdownManager({
      extensions: resolveExtensions(buildContentExtensions()),
      markedOptions: { gfm: true },
    });
  }
  return cached;
}

/** Build a one-off manager with extra (e.g. mention) extensions — used when the host injects them. */
export function createMarkdownManager(opts: BuildExtensionsOptions = {}): MarkdownManager {
  return new MarkdownManager({
    extensions: resolveExtensions(buildContentExtensions(opts)),
    markedOptions: { gfm: true },
  });
}

/** Markdown string → Tiptap/ProseMirror JSON document. */
export function parseMarkdownToDoc(markdown: string): JSONContent {
  return manager().parse(markdown);
}

/** Tiptap/ProseMirror JSON document → markdown string (canonical, normalized form). */
export function serializeDocToMarkdown(doc: JSONContent): string {
  return manager().serialize(doc);
}

/** Round-trip markdown through parse→serialize, yielding the normalized canonical form. */
export function normalizeMarkdown(markdown: string): string {
  return serializeDocToMarkdown(parseMarkdownToDoc(markdown));
}
