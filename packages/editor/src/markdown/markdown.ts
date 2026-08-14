import { type JSONContent, resolveExtensions } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import {
  type BuildExtensionsOptions,
  buildContentExtensions,
} from "../extensions/build-extensions";

/*
 * DOM-free markdown ⇄ ProseMirror bridge. Markdown is canonical; first serialization normalizes,
 * then round-trips are stable.
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

/** Build a one-off manager with host-injected extensions such as mentions. */
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
