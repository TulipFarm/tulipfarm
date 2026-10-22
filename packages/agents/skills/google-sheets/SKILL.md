---
name: google-sheets
title: Create and edit Google Sheets
description: Create a styled Google Sheet with live formulas in the person's Drive from a JSON spec, or change a Google Sheet, with owner approval. Use it whenever someone wants a spreadsheet, tracker, or budget in Google Sheets or Drive, even if they only say "sheet".
---

# Create and edit Google Sheets

If the person asks to change an existing file, keep its ID and edit that original where allowed below. `document` always creates a new file. Do not replace an edit with a new file or copy unless the person agrees.

## Create a new Google Sheet

TulipFarm makes a new Google Sheet from the same JSON spec as the `excel-workbook` skill, then Drive converts it to a native Google Sheet.

1. Read `excel-workbook` with `skills.read` (pass `skillId: "excel-workbook"`), and its `references/spec.md` resource. Follow its planning and spec steps.
2. Call `google.propose` with `document: {name, format: "xlsx", content}` and no `operation`. `content` is the spec as a JSON string. Set `folderId` only for a Drive folder the person named and you found with `google.read`.
3. The proposal is a review card, not a saved file. Ask the person to approve it on the card. Never approve it yourself, and never ask for its ID.
4. When they say to proceed, check it with `google.status`, then run it with `google.execute`. Share the file link from the result.

If `google.propose` is not in your tools, or it returns `integration-required`, Google is not connected. Offer to save the same file to TulipFarm Files with `files.create` and `format: "xlsx"` instead.

## Change an existing Google Sheet

To add rows to any sheet, propose `sheets.values.append` with `valueInputOption: "USER_ENTERED"` so that formulas such as `=SUM(B2:B9)` stay live.

To overwrite or format cells, use `sheets.values.update`, `sheets.values.batchUpdate`, `sheets.values.clear`, or `sheets.spreadsheets.batchUpdate`. These are allowed only on a sheet that TulipFarm made in this workspace: one created by this skill, by `sheets.spreadsheets.create`, by a new `drive.files.upload`, or by `drive.files.copy`. They need both Sheets and Drive access to check for intervening edits. Reuse that same spreadsheet on later edits; do not copy it again. For any other sheet, explain the safety limit and ask before making a copy with `drive.files.copy`. If they agree, change the copy and tell them that the original is unchanged.

Every change is a `google.propose` call with an `operation`, then approval on its review card, then `google.execute`. Read the file with `google.read` first, so that the change uses current content.

## When a call fails

- `invalid-operation`: nothing was proposed. The message names the problem. Fix it and propose again once.
- `operation-unguarded-update`: Google cannot confirm that the original still matches what the owner reviews. Ask whether the person wants a copy; do not silently create one.
- `operation-revision-required` or `operation-target-stale`: the file changed or the revision is missing. Read it again with `google.read`, then propose the change again for fresh approval.
- `integration-required` or `reconnect-required`: Google is not usable. Say so, and offer Files instead.
- `tool-failed`: the cause is unconfirmed. Do not say a permission is missing.
- Only an explicit `access-denied` establishes a denial.

Report unresolved failures accurately.
