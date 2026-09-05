---
name: pdf-generation
description: Generate reviewable PDF reports and documents.
category: core
tools: [file_create]
---
# PDF Generation Skill

Create a bounded PDF from Markdown with clear structure and accessible reading order. This Skill
does not add scripts, remote content, forms, attachments, or arbitrary HTML.

## When to Use

Use when the user asks for a PDF report, brief, memo, handout, or printable document — anything
that must look the same for everyone and will not be edited afterwards.

Choose a different format when the user will edit it (`document-generation`), will sort or filter
it (`spreadsheet-generation`), or will present it (`presentation-generation`).

## Prerequisites

- The facts and source material needed for the document.
- A filename and a concise title.

## How to Run

Draft the complete document as Markdown, then call `file_create` with `format: "pdf"`.

## Quick Reference

- Use real heading levels in order.
- Use short paragraphs and descriptive link text.
- Give tables a header row and keep them narrow.
- Describe important visual meaning in text.

## Procedure

1. Confirm the requested scope from the available context.
2. Choose a deterministic kebab-case filename based on the document purpose.
3. Write Markdown with one clear title and ordered headings.
4. Call `file_create` once.
5. In Chat, describe the draft and ask the user to review, download, save, or request revisions.
6. In a Routine, report the saved filename and its purpose.

## Pitfalls

- Do not claim a Chat draft is saved.
- Do not repeat the full document in the reply.
- Do not embed HTML, scripts, remote images, or private data not requested by the user.
- Split content that would exceed the Tool's stated size or page bounds.

## Verification

Confirm the Tool returned a PDF filename. In Chat, confirm it returned `status: "draft"`; in a
Routine, confirm it returned `status: "saved"`.
