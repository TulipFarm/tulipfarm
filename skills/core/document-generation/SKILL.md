---
name: document-generation
description: Generate Word documents (.docx) for reports, memos, letters, proposals, and briefs.
category: core
tools: [file_create]
---
# Document Generation Skill

Create a Word document (`.docx`) from Markdown. The renderer builds the Office package directly,
so the document opens in Word, Pages, LibreOffice, and Google Docs with real headings, real lists,
and real tables — not a picture of them.

This Skill writes no macros, no embedded objects, no remote images, and no external links.

## When to Use

Use when the user asks for a Word document, a `.docx`, an editable document, or a deliverable
someone else will edit: a report, memo, letter, proposal, brief, policy, or meeting record.

Choose a different format when:

| The user wants | Use |
| --- | --- |
| Something to print or forward unchanged | `pdf-generation` |
| A table of data, a workbook, an export | `spreadsheet-generation` |
| Slides, a deck, a presentation | `presentation-generation` |
| A config, feed, or machine-read file | `structured-text-generation` |

If the user says only "a document" and someone will edit it afterwards, pick `docx`. If they will
only read it, pick `pdf`.

## Prerequisites

- The facts and source material the document must contain.
- A filename and a concise title.

## How to Run

Write the whole document as Markdown, then call `file_create` with `format: "docx"`.

## Quick Reference

Markdown maps onto Word styles:

| Markdown | Becomes |
| --- | --- |
| `#` to `######` | Heading 1-6, so the navigation pane and any table of contents work |
| `**bold**`, `*italic*`, backticked code | Bold, italic, and a monospace run |
| `- item` / `1. item` | A real bulleted or numbered list, indented by nesting depth |
| `> quote` | The Quote style |
| A fenced code block | A preformatted block |
| A pipe table | A bordered table with a bold header row |
| `---` | A horizontal rule |

## Procedure

1. Confirm the scope and the audience from the available context.
2. Choose a deterministic kebab-case filename, and let the Tool add `.docx`.
3. Open the body with a single `#` title, then use heading levels in order without skipping.
4. Write the body as Markdown. Keep paragraphs short and give every table a header row.
5. Call `file_create` once with `format: "docx"`.
6. In Chat, describe the draft and ask the user to review, download, save, or revise it.
7. In a Routine, report the saved filename and what is in it.

## Pitfalls

- Do not expect `title` and a `#` heading to both appear. The title is a fallback, used only when
  the content has no top-level heading of its own.
- Do not embed HTML. It is not parsed, and it appears as literal angle brackets in the text.
- Do not rely on a link's target. A hyperlink's label is kept and the URL is dropped, because the
  package writes no relationship that resolves outside itself. Put a URL in the prose when the
  reader needs it.
- Do not use images. They are not embedded; describe the visual in text instead.
- Do not use a table for layout. Use headings and paragraphs.
- Do not claim a Chat draft is saved, and do not repeat the whole document in your reply.

## Verification

Confirm the Tool returned a `.docx` filename with media type
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`. In Chat confirm
`status: "draft"`; in a Routine confirm `status: "saved"`.
