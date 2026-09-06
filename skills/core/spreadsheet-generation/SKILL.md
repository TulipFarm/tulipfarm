---
name: spreadsheet-generation
description: Generate Excel workbooks (.xlsx) and CSV exports for tabular data.
category: core
tools: [file_create]
---
# Spreadsheet Generation Skill

Create a spreadsheet as an Excel workbook (`.xlsx`) or as a portable CSV. Both start from the same
CSV body you write; the format decides what the reader gets.

This Skill writes no formulas, macros, links, or external data connections.

## When to Use

Use for tabular exports, data sheets, summaries by row, and anything the user will sort or filter.

| The user wants | Use |
| --- | --- |
| To open it in Excel, Numbers, or Sheets and work with it | `xlsx` |
| To feed it to another system, or asked for CSV by name | `csv` |
| Prose with a table in it | `document-generation` or `pdf-generation` |

Default to `xlsx` when a person will read it and `csv` when a machine will.

## Prerequisites

- A defined column order.
- Rows whose values can be represented as text.

## How to Run

Build one RFC 4180 CSV body and call `file_create` with `format: "xlsx"` or `format: "csv"`.

## Quick Reference

- Put column names in the first row. For `xlsx` that row is styled bold and frozen, so it stays
  visible while scrolling.
- Quote any field containing a comma, a quote, or a line break.
- Escape a quote inside a quoted field as two quotes.
- For `xlsx`, `title` names the worksheet. Keep it under 31 characters and free of `\ / ? * [ ]`.

## Procedure

1. Fix the column order before writing rows.
2. Use one row per record and keep every row at the same column count.
3. Neutralize formula-like user values — prefix a cell beginning with `=`, `+`, `-`, or `@` with a
   single quote unless the user explicitly asked for a formula.
4. Choose a deterministic kebab-case filename.
5. Call `file_create` once with the chosen format.
6. In Chat, ask the user to review and save the draft or request a revision.

## Pitfalls

- Do not assume every numeric-looking cell becomes a number in `xlsx`. A value is stored as a
  number only when the text round-trips exactly, so `007`, `1,200`, and `+44` stay text — which is
  what you want for identifiers and phone numbers, and what you must not fight by stripping the
  leading zero.
- Do not write formulas. They are stored as the literal text you wrote, not evaluated.
- Do not use multiple sheets, merged cells, colours, or column widths. One sheet, one header row.
- Do not invent missing values; leave the field empty.
- Do not claim a Chat draft is saved.

## Verification

Confirm the filename ends in `.xlsx` or `.csv` and the media type matches
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` or `text/csv`. In Chat confirm
`status: "draft"`; in a Routine confirm `status: "saved"`.
