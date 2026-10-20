---
name: google-slides
title: Create and edit Google Slides
description: Create a styled Google Slides presentation in the person's Drive from a JSON spec, or change an existing one, with owner approval. Use it whenever someone wants slides or a presentation in Google Slides or Drive, even if they only say "deck".
---

# Create and edit Google Slides

If the person asks to change an existing file, keep its ID and edit that original. `document` always creates a new file. Do not replace an edit with a new file or copy unless the person agrees.

## Create a new Google Slides presentation

TulipFarm makes a new Google Slides presentation from the same JSON spec as the `powerpoint-deck` skill, then Drive converts it to a native Google Slides presentation.

1. Read `powerpoint-deck` with `skills.read` (pass `skillId: "powerpoint-deck"`), and its `references/spec.md` resource. Follow its planning and spec steps.
2. Call `google.propose` with `document: {name, format: "pptx", content}` and no `operation`. `content` is the spec as a JSON string. Set `folderId` only for a Drive folder the person named and you found with `google.read`.
3. The proposal is a review card, not a saved file. Ask the person to approve it on the card. Never approve it yourself, and never ask for its ID.
4. When they say to proceed, check it with `google.status`, then run it with `google.execute`. Share the file link from the result.

If `google.propose` is not in your tools, or it returns `integration-required`, Google is not connected. Offer to save the same file to TulipFarm Files with `files.create` and `format: "pptx"` instead.

## Change an existing Google Slides presentation

Read it with `slides.presentations.get` and keep its `revisionId`. Propose `slides.presentations.batchUpdate` with `presentationId`, `requests`, and `requiredRevisionId` set to that `revisionId`. Use Slides API requests such as `replaceAllText`, `insertText`, `deleteText`, `createSlide`, `deleteObject`, `updateSlidesPosition`, `updatePageElementTransform`, and `updateTextStyle`. Object IDs come from the presentation you read.

For a large deck, read `slides.presentations.get` with `view: "outline"`, then `slides.presentations.pages.get` for each relevant slide. Compact reads omit styles and grouped text. Use the page read with `detail: {}` for full element details, or `detail: {elementId}` for one element, including a nested group child. The latter returns ancestor group transforms too. Narrow a large table with `detail: {elementId, cellLocation: {rowIndex, columnIndex}}`; narrow long text with `range: {startIndex, endIndex}` inside `detail` (at most 10,000 UTF-16 code units). Keep all reads used for an edit on the same `revisionId`; restart if it changes.

Use `cellLocation` for table-cell insert, delete, or text-style edits. Styles support bold, italic, underline, strikethrough, and font size in PT. `updateSlidesPosition.slideObjectIds` must be in their current order; `insertionIndex` is the position before the move. Element transforms support `ABSOLUTE` or `RELATIVE` mode and PT or EMU units. Use only the fields exposed by the tool, not arbitrary Slides API requests.

For a large redesign, edit the original in reviewed batches and read it again after each batch. If the tools cannot make a required change, explain that limit and ask before creating a replacement.

Every change is a `google.propose` call with an `operation`, then approval on its review card, then `google.execute`. Read the file with `google.read` first, so that the change uses current content.

## When a call fails

- `invalid-operation`: nothing was proposed. The message names the problem. Fix it and propose again once.
- `operation-unguarded-update`: the original cannot be changed safely through this operation. Explain the limit; offer a copy only with the person's agreement.
- `operation-revision-required` or `operation-target-stale`: the file changed or the revision is missing. Read it again with `google.read`, then propose the change again for fresh approval.
- `result-too-large` or `response-too-large`: use outline, page, element, cell, or text-range reads to narrow the result. A full provider response still must fit within 2 MiB. Report an unresolved read limit instead of creating a replacement.
- `integration-required` or `reconnect-required`: Google is not usable. Say so, and offer Files instead.
- `tool-failed`: the cause is unconfirmed. Do not say a permission is missing.
- Only an explicit `access-denied` establishes a denial.

Report unresolved failures accurately.
