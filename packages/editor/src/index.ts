// @tulipfarm/editor — shared TipTap markdown editor for the knowledge wiki.
// Markdown is the canonical store; the editor loads from / saves to markdown at the boundary.

export {
  type BuildExtensionsOptions,
  buildContentExtensions,
} from "./extensions/build-extensions";
export {
  CALLOUT_ALERT_RE,
  CALLOUT_KINDS,
  Callout,
  type CalloutKind,
} from "./extensions/callout";
export {
  createMarkdownManager,
  normalizeMarkdown,
  parseMarkdownToDoc,
  serializeDocToMarkdown,
} from "./markdown/markdown";
export {
  filterMentionSections,
  filterTagSuggestions,
  type MentionDataSource,
  type MentionItem,
  type MentionSection,
} from "./mentions/host-data";
export { buildMentionExtensions } from "./mentions/mention-menu";
export { PageEditor, type PageEditorProps } from "./page-editor";
export { filterSlashItems, SLASH_ITEMS, type SlashItem } from "./slash/slash-items";
export { SlashCommands } from "./slash/slash-menu";
