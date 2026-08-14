# Editor (`@tulipfarm/editor`)

Shared TipTap markdown editor for the knowledge wiki and Routine authoring helpers.
Markdown is the canonical store at the package boundary.

## Read on / Skip

- **Read on if** you touch rich-text editing, markdown round-trips, mentions, slash commands,
  or Routine authoring drafts.
- **Skip if** you build host routes, save/load flows, or page data APIs; use
  `../../apps/web/AGENTS.md`.

## Map

| Path | Owns |
| --- | --- |
| `src/page-editor.tsx` | Controlled React editor; value in/out is markdown. |
| `src/extensions/` | Canonical TipTap content schema and callout extension. |
| `src/markdown/` | DOM-free markdown ⇄ ProseMirror JSON bridge. |
| `src/mentions/` | Host-injected `@` and `#` suggestion filtering and menus. |
| `src/slash/` | Slash command catalog and menu. |
| `src/routine/` | YAML Routine authoring session validation and changeset proposal. |

## Rules

- Keep markdown canonical; TipTap/ProseMirror JSON is internal only.
- Host apps inject mention data and save/load behavior; this package must not import app API
  clients.
- React, React DOM, and TipTap core packages are peer dependencies supplied by consumers.
