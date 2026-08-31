/**
 * Renders as a clickable link (`MarkdownView` parses it into an `<a>`), so a verbatim copy of the
 * message should read the same way — not as source syntax. Handles the common inline forms
 * (`[text](url)`, autolinked bare/angle-bracket URLs) without pulling in a full markdown parser
 * for what is otherwise a straight passthrough copy.
 */
export function markdownLinksToPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\((?:[^()\s]+)(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
}
