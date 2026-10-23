# Document spec

`content` is a JSON string with this shape. Unknown properties are rejected.

```json
{
  "theme": "default",
  "accentColor": "#2563EB",
  "orientation": "portrait",
  "header": "Acme Corp — Confidential",
  "footer": "Prepared by Operations",
  "pageNumbers": true,
  "blocks": []
}
```

Only `blocks` is required. `theme` is one of `default`, `modern`, `classic`, `bold`, or `minimal`. `accentColor` replaces the theme's accent colour, which colours the title, headings, links, quote bars, and table header rows. `orientation` is `portrait` or `landscape`.

## Text

Every `text` value is either a plain string or an array of runs:

```json
[
  "Revenue grew ",
  { "text": "12%", "bold": true },
  " — see ",
  { "text": "the report", "link": "https://example.com/q3" }
]
```

A run has `text` and any of `bold`, `italic`, `underline`, `strike`, `code` (monospace), `color` (`#RRGGBB`), and `link` (an absolute URL).

## Blocks

| `type`      | Properties                                                     | Notes                                                                                        |
| ----------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `title`     | `text`, optional `subtitle`                                    | Use once, at the top.                                                                        |
| `heading`   | `level` 1–4, `text` (string)                                   | Keep levels in order; do not skip from 1 to 3.                                               |
| `paragraph` | `text`, optional `align`: `left`, `center`, `right`, `justify` |                                                                                              |
| `list`      | `items`, optional `ordered`                                    | Each item is text, or `{"text": ..., "items": [...]}` for a nested list. Up to three levels. |
| `table`     | `header` (array of text), `rows` (array of rows of text)       | The header row uses the accent colour. Keep every row as wide as the header.                 |
| `quote`     | `text`                                                         | Indented, italic, with an accent bar.                                                        |
| `code`      | `text` (string, may contain newlines)                          | Monospace on a tinted background.                                                            |
| `divider`   | —                                                              | A horizontal rule.                                                                           |
| `pageBreak` | —                                                              | Starts a new page.                                                                           |
| `toc`       | optional `title` (default `Contents`)                          | A table of contents built from heading levels 1–3. Put it after the title.                   |
| `image`     | `fileId`, optional `width` (10–100), optional `alt`            | A PNG, JPEG, or GIF from Files, centred. `width` is a percentage of the text width.          |

## Example

```json
{
  "theme": "modern",
  "pageNumbers": true,
  "blocks": [
    { "type": "title", "text": "Onboarding guide", "subtitle": "Customer Support team" },
    { "type": "heading", "level": 1, "text": "Your first week" },
    { "type": "paragraph", "text": ["Read this guide before ", { "text": "Monday", "bold": true }, "."] },
    {
      "type": "list",
      "ordered": true,
      "items": [
        "Get your accounts",
        { "text": "Shadow two senior agents", "items": ["Morning shift", "Evening shift"] },
        "Answer your first ticket"
      ]
    },
    { "type": "heading", "level": 2, "text": "Response targets" },
    {
      "type": "table",
      "header": ["Priority", "First reply", "Resolution"],
      "rows": [
        ["Urgent", "1 hour", "8 hours"],
        ["Normal", "8 hours", "3 days"]
      ]
    },
    { "type": "quote", "text": "Every reply should leave the customer knowing what happens next." },
    { "type": "pageBreak" },
    { "type": "heading", "level": 1, "text": "Tools" },
    { "type": "code", "text": "Macro: /refund-approved\nTag: billing" }
  ]
}
```

## Pitfalls

- The table of contents is a Word field. Word fills in page numbers when the file opens and may ask to update fields. Google Docs shows the entries; refresh it there with its update button.
- Each `list` block starts its own numbering at 1. To continue a list, keep its items in one block.
- Headings are plain strings; put bold or links in the paragraph that follows.
- Long tables split across pages automatically, and the header row repeats on each page.

- An `image` needs the Files id of a PNG, JPEG, or GIF the person can open, such as an attachment in the chat. Up to 20 images, each at most 8 MiB. Images are never enlarged past their own size. Write `alt` text that says what the image shows.
- Images work in Files only. Google Drive proposals reject image blocks for now.

Charts, footnotes, comments, and tracked changes are not supported. Describe a chart's data in a table instead.
