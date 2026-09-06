---
name: structured-text-generation
description: Generate validated JSON, XML, YAML, Markdown, or text.
category: core
tools: [file_create]
---
# Structured Text Generation Skill

Create validated local structured-text Files. This Skill does not resolve external entities,
schemas, includes, remote references, custom YAML tags, or executable content.

## When to Use

Use for JSON, XML, YAML, Markdown, or plain-text documents and exports.

## Prerequisites

- The requested format.
- The fields, hierarchy, or prose the File must contain.

## How to Run

Create the complete body, then call `file_create` with `format` set to `json`, `xml`, `yaml`,
`markdown`, or `text`.

## Quick Reference

- JSON: use valid JSON values and double-quoted keys.
- XML: use one root element and no DTD, entity declaration, processing instruction, or include.
- YAML: use ordinary mappings, sequences, and scalar values only.
- Markdown: do not embed HTML or remote content.

## Procedure

1. Match the exact format requested.
2. Choose a deterministic kebab-case filename.
3. Keep keys and element names stable and descriptive.
4. Call `file_create` once; fix validation errors rather than changing formats silently.
5. In Chat, ask the user to review and save the draft or request a revision.
6. In a Routine, state that the output was saved automatically.

## Pitfalls

- Do not wrap the body in a Markdown code fence.
- Do not use XML external entities or include elements.
- Do not use YAML tags, anchors, aliases, or merge keys.
- Do not use these formats for a deliverable a person will read. A report is
  `document-generation` or `pdf-generation`; a table is `spreadsheet-generation`; slides are
  `presentation-generation`. Markdown is for a file another tool will render.

## Verification

Confirm the returned media type matches the requested format and the result status matches the
calling surface.
