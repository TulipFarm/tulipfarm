---
name: excel-workbook
title: Create Excel workbooks
description: Create a styled Excel (.xlsx) workbook with live formulas from a JSON spec, saved to Files or Google Drive. Use it whenever someone wants a spreadsheet, budget, tracker, schedule, price list, calculator, or data export to download or share, even if they do not say "Excel" or "xlsx".
---

# Create Excel workbooks

You write a JSON spec. TulipFarm renders it into a real `.xlsx` file with the chosen theme. You never write file bytes, XML, or base64 yourself.

## 1. Plan the workbook

Decide the sheets and columns first. Put raw data on one sheet and totals or summaries on another. Give each sheet `columns` with headers and number formats, so row 1 is a styled header and data starts at row 2.

Use formulas for every computed value: totals, averages, lookups, and percentages. A formula stays correct when the person edits the data; a typed number does not.

## 2. Write the spec

Read `references/spec.md` with `skills.read` (pass `resource`) before you write the first spec in a chat. It lists every element, the theme names, a full example, and the pitfalls.

- Pick a `theme`: `default` (blue, Calibri), `modern` (teal, Arial), `classic` (brown, Georgia and Times New Roman), `bold` (pink, Trebuchet and Verdana), or `minimal` (black and grey, Arial). Use `accentColor` for a brand colour the person gives.
- Use real content from the conversation, tables, rows, and knowledge. Do not invent numbers, names, or dates. When data is missing, leave a clear placeholder such as `[Client name]` and tell the person.
- Store numbers as numbers and dates as `{"date": "YYYY-MM-DD"}`. Use `format` for currency and percentages.
- Use `filter` and `bandedRows` for long lists, and `dropdowns` for status or category columns.
- Check every formula reference against the row numbers before you save.

## 3. Choose where to save it

Ask one short question: save to Google Drive or to TulipFarm Files? Ask only when `google.propose` is in your tools. Without it, use Files and do not ask. If the person already named a destination, use it.

- **Files**: call `files.create` with `name` (include the `.xlsx` extension), `format: "xlsx"`, and `content` set to the spec as a JSON string. Set `folderId` only when the person named an accessible folder. The created-file card lets the person open and download the file.
- **Google Drive**: call `google.propose` with `document: {name, format: "xlsx", content}` and no `operation`. Set `folderId` only for a Drive folder the person named and you found with `google.read`. Drive converts the file to a native Google Sheet. The proposal is a review card, not a saved file. Ask the person to approve it on the card. When they say to proceed, check it with `google.status`, then run it with `google.execute`. Share the link from the result.

Never claim the file exists before `files.create` or `google.execute` succeeds.

## 4. Confirm

Say what you made in one or two sentences: the name, where it is saved, and its main parts. Do not paste the spec into chat.

To change the file, write the full spec again with the change and save a new file. TulipFarm cannot edit an existing Office file in place.

## When a call fails

- `invalid-content` from `files.create`, or `invalid-operation` from `google.propose`: no file was made. The message names the spec problem. Fix that part of the spec and call again once.
- `integration-required` or `reconnect-required`: Google is not usable. Say so, and offer to save to Files instead.
- `tool-failed`: the cause is unconfirmed. Do not say a permission is missing.
- Only an explicit `access-denied` establishes a denial. Do not guess which permission caused it.

Report unresolved failures accurately.
