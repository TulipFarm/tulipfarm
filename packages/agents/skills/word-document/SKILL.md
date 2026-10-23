---
name: word-document
title: Create Word documents
description: Create a styled Word (.docx) document from a JSON spec, saved to Files or Google Drive. Use it whenever someone wants a report, letter, proposal, policy, contract draft, guide, minutes, or any written document to download or share, even if they do not say "Word" or "docx".
---

# Create Word documents

You write a JSON spec. TulipFarm renders it into a real `.docx` file with the chosen theme. You never write file bytes, XML, or base64 yourself.

## 1. Plan the document

Decide the sections before you write. Use one `title`, then `heading` blocks in order (level 1, then 2, then 3). Put lists, tables, quotes, and images where they help the reader. Add a `toc` block after the title for documents with more than about five headings. Add `pageNumbers`, and a `header` or `footer` for formal documents.

Ask only about choices that change the document, such as audience or length. If the request is clear, write it.

## 2. Write the spec

Read `references/spec.md` with `skills.read` (pass `resource`) before you write the first spec in a chat. It lists every element, the theme names, a full example, and the pitfalls.

- Pick a `theme`: `default` (blue, Calibri), `modern` (teal, Arial), `classic` (brown, Georgia and Times New Roman), `bold` (pink, Trebuchet and Verdana), or `minimal` (black and grey, Arial). Use `accentColor` for a brand colour the person gives.
- Use real content from the conversation, tables, rows, and knowledge. Do not invent numbers, names, or dates. When data is missing, leave a clear placeholder such as `[Client name]` and tell the person.
- Keep paragraphs short. Use `list` for steps and options, and `table` for comparisons and figures.

## 3. Choose where to save it

Ask one short question: save to Google Drive or to TulipFarm Files? Ask only when `google.propose` is in your tools. Without it, use Files and do not ask. If the person already named a destination, use it.

- **Files**: call `files.create` with `name` (include the `.docx` extension), `format: "docx"`, and `content` set to the spec as a JSON string. Set `folderId` only when the person named an accessible folder. The created-file card lets the person open and download the file.
- **Google Drive**: images are not supported yet; if the spec has an `image` block, save to Files instead. Otherwise call `google.propose` with `document: {name, format: "docx", content}` and no `operation`. Set `folderId` only for a Drive folder the person named and you found with `google.read`. Drive converts the file to a native Google Doc. The proposal is a review card, not a saved file. Ask the person to approve it on the card. When they say to proceed, check it with `google.status`, then run it with `google.execute`. Share the link from the result.

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
