---
name: google-docs
title: Create and edit Google Docs
description: Create a styled Google Doc in the person's Drive from a JSON spec, or change an existing Google Doc, with owner approval. Use it whenever someone wants a document in Google Docs or Drive, even if they only say "doc" or "share it in Drive".
---

# Create and edit Google Docs

If the person asks to change an existing file, keep its ID and edit that original. `document` always creates a new file. Do not replace an edit with a new file or copy unless the person agrees.

## Create a new Google Doc

TulipFarm makes a new Google Doc from the same JSON spec as the `word-document` skill, then Drive converts it to a native Google Doc.

1. Read `word-document` with `skills.read` (pass `skillId: "word-document"`), and its `references/spec.md` resource. Follow its planning and spec steps.
2. Call `google.propose` with `document: {name, format: "docx", content}` and no `operation`. `content` is the spec as a JSON string. Set `folderId` only for a Drive folder the person named and you found with `google.read`.
3. The proposal is a review card, not a saved file. Ask the person to approve it on the card. Never approve it yourself, and never ask for its ID.
4. When they say to proceed, check it with `google.status`, then run it with `google.execute`. Share the file link from the result.

If `google.propose` is not in your tools, or it returns `integration-required`, Google is not connected. Offer to save the same file to TulipFarm Files with `files.create` and `format: "docx"` instead.

## Change an existing Google Doc

Read it with `docs.documents.get` and keep its `revisionId`. Propose `docs.documents.batchUpdate` with `documentId`, `requests`, and `requiredRevisionId` set to that `revisionId`. Use Docs API requests such as `insertText`, `replaceAllText`, `deleteContentRange`, `updateTextStyle`, `updateParagraphStyle`, `createParagraphBullets`, and `insertTable`. Indexes come from the document you read; apply edits from the end of the document to the start so earlier indexes stay valid.

For a large document, read `docs.documents.get` with `selection: {view: "outline"}` for tab IDs and segment end indexes. Then use `selection: {view: "range", tabId, range: {startIndex, endIndex}}`, with at most 10,000 UTF-16 code units per range. Include `segmentId` to read a listed header, footer, or footnote. Returned text indexes remain document indexes, not offsets into the excerpt. Carry the tab and segment IDs into indexed edits. Read all ranges needed for the edit at the same `revisionId`; restart if it changes. `replaceAllText` without tab criteria affects all tabs.

`updateParagraphStyle` supports named headings, alignment, line spacing, and space above/below. `createParagraphBullets` supports `BULLET_DISC_CIRCLE_SQUARE`, `BULLET_CHECKBOX`, `NUMBERED_DECIMAL_ALPHA_ROMAN`, and `NUMBERED_DECIMAL_NESTED`. Adding bullets can remove leading tabs and change later indexes, so re-read before later indexed edits. Text styles support bold, italic, underline, strikethrough, and `fontSize: {magnitude, unit: "PT"}`. Use only the fields exposed by the tool, not arbitrary Docs API requests.

Every change is a `google.propose` call with an `operation`, then approval on its review card, then `google.execute`. Read the file with `google.read` first, so that the change uses current content.

## When a call fails

- `invalid-operation`: nothing was proposed. The message names the problem. Fix it and propose again once.
- `operation-unguarded-update`: the original cannot be changed safely through this operation. Explain the limit; offer a copy only with the person's agreement.
- `operation-revision-required` or `operation-target-stale`: the file changed or the revision is missing. Read it again with `google.read`, then propose the change again for fresh approval.
- `result-too-large`: use the outline and range reads above. For a selected range that returns `response-too-large`, reduce the range. The provider still has a 2 MiB response limit; if even the outline fails at that limit, report that the document cannot be read through this tool. Do not create a replacement.
- `integration-required` or `reconnect-required`: Google is not usable. Say so, and offer Files instead.
- `tool-failed`: the cause is unconfirmed. Do not say a permission is missing.
- Only an explicit `access-denied` establishes a denial.

Report unresolved failures accurately.
