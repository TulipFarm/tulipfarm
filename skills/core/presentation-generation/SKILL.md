---
name: presentation-generation
description: Generate PowerPoint decks (.pptx) for slides, presentations, and readouts.
category: core
tools: [file_create]
---
# Presentation Generation Skill

Create a PowerPoint deck (`.pptx`) from Markdown. Each top-level heading becomes a slide, and the
lines beneath it become that slide's bullets. The deck opens in PowerPoint, Keynote, LibreOffice,
and Google Slides.

This Skill writes no macros, no embedded media, no remote images, and no external links.

## When to Use

Use when the user asks for slides, a deck, a presentation, a readout, a pitch, or a review — or
names a `.pptx` file.

Choose a different format when the user wants a document to read (`pdf-generation` or
`document-generation`) or a table of data (`spreadsheet-generation`). A deck is for talking to;
if nobody is presenting it, it is a document.

## Prerequisites

- The narrative: what each slide has to land, in order.
- A filename and a deck title.

## How to Run

Write the deck as Markdown, one `#` or `##` heading per slide, then call `file_create` with
`format: "pptx"`.

## Quick Reference

| Markdown | Becomes |
| --- | --- |
| `#` or `##` heading | A new slide, with that heading as its title |
| `###` and deeper | A line on the current slide, not a new slide |
| `- item` | A bullet, indented by its nesting depth (up to five levels) |
| A paragraph | A line on the current slide |
| A pipe table | The header row, then one line per row |
| `---` | Nothing — use a heading to start a slide |

The slide canvas is 16:9. A slide carrying more than 12 lines continues onto a second slide
titled `<name> (cont.)` rather than overflowing off the bottom edge.

## Procedure

1. Decide the slide sequence before writing anything — one idea per slide.
2. Choose a deterministic kebab-case filename, and let the Tool add `.pptx`.
3. Open with a `#` title slide, then one `##` heading per content slide.
4. Keep each bullet to one line. Six or fewer bullets per slide reads best.
5. Call `file_create` once with `format: "pptx"`.
6. In Chat, describe the draft and ask the user to review, download, save, or revise it.
7. In a Routine, report the saved filename and the slide count.

## Pitfalls

- Do not write paragraphs. Anything long becomes one unreadable line on a slide; put the detail in
  the spoken narrative or a companion `docx`.
- Do not use `---` to separate slides. A heading starts a slide; a rule is ignored.
- Do not lead with content before the first heading — it lands on a slide titled from `title`, or
  "Overview" when there is none. Write the heading first.
- Do not use images, charts, or speaker notes. None are embedded; state the number in the bullet
  instead of describing a chart of it.
- Do not rely on a link's target; the label is kept and the URL is dropped.
- Do not claim a Chat draft is saved, and do not repeat every slide in your reply.

## Verification

Confirm the Tool returned a `.pptx` filename with media type
`application/vnd.openxmlformats-officedocument.presentationml.presentation`. In Chat confirm
`status: "draft"`; in a Routine confirm `status: "saved"`.
