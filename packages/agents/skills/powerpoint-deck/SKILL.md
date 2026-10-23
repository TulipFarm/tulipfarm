---
name: powerpoint-deck
title: Create PowerPoint decks
description: Create a styled PowerPoint (.pptx) deck from a JSON spec, saved to Files or Google Drive. Use it whenever someone wants slides, a presentation, a pitch, a training deck, or a review deck to download or share, even if they do not say "PowerPoint" or "pptx".
---

# Create PowerPoint decks

You write a JSON spec. TulipFarm renders it into a real `.pptx` file with the chosen theme. You never write file bytes, XML, or base64 yourself.

## 1. Plan the deck

Outline the story before you write: a `title` slide, then one idea per slide. Use `section` slides between parts of a long deck. Use `two-column` for comparisons. Put numbers in a `chart` or `table`, not in long text. Place an attached or saved picture with an `image` block. Add `notes` with what the presenter should say.

Ask only about choices that change the deck, such as audience or length. If the request is clear, write it.

## 2. Write the spec

Read `references/spec.md` with `skills.read` (pass `resource`) before you write the first spec in a chat. It lists every element, the theme names, a full example, and the pitfalls.

- Pick a `theme`: `default` (blue, Calibri), `modern` (teal, Arial), `classic` (brown, Georgia and Times New Roman), `bold` (pink, Trebuchet and Verdana), or `minimal` (black and grey, Arial). Use `accentColor` for a brand colour the person gives.
- Use real content from the conversation, tables, rows, and knowledge. Do not invent numbers, names, or dates. When data is missing, leave a clear placeholder such as `[Client name]` and tell the person.
- Keep each slide to one or two blocks, about six short bullets, or about eight table rows. Text does not shrink to fit.
- Turn on `slideNumbers` for decks longer than about five slides.

## 3. Choose where to save it

Ask one short question: save to Google Drive or to TulipFarm Files? Ask only when `google.propose` is in your tools. Without it, use Files and do not ask. If the person already named a destination, use it.

- **Files**: call `files.create` with `name` (include the `.pptx` extension), `format: "pptx"`, and `content` set to the spec as a JSON string. Set `folderId` only when the person named an accessible folder. The created-file card lets the person open and download the file.
- **Google Drive**: call `google.propose` with `document: {name, format: "pptx", content}` and no `operation`. Set `folderId` only for a Drive folder the person named and you found with `google.read`. Drive converts the file to a native Google Slides presentation. The proposal is a review card, not a saved file. Ask the person to approve it on the card. When they say to proceed, check it with `google.status`, then run it with `google.execute`. Share the link from the result.

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
