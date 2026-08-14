# Docs site

`@tulipfarm/docs` is the public Fumadocs site on Next.js, built as a static export.
It owns docs content, MDX rendering, prompt blocks, install snippets, and site styling.

## Read on / Skip

- **Read on if** your task changes public docs, MDX components, Fumadocs config, install
  snippets, docs search/OG routes, or docs-only style.
- **Skip if** you are changing product UI (`../web/AGENTS.md`), API behavior
  (`../api/AGENTS.md`), worker behavior (`../worker/AGENTS.md`), or architecture notes in
  root `docs/architecture/`.

## Map

| Path | Owns |
| --- | --- |
| `content/docs/` | Public docs content; `meta.json` sets nav order and separators. |
| `content/docs/concepts/` | Explanations: how/why; link to guides for steps. |
| `content/docs/guides/` | How-to recipes; build tasks must be prompt-first. |
| `content/docs/reference/` | Complete, neutral reference for env vars and commands. |
| `content/docs/security/` | Security reference and explanations. |
| `source.config.ts` | Fumadocs MDX/frontmatter config and remark plugins. |
| `components/mdx.tsx` | MDX component map; register custom MDX components here. |
| `components/prompt-block.tsx` | Rendered ` ```prompt ` block component. |
| `lib/remark-prompt.ts` | Rewrites ` ```prompt ` to `<PromptBlock>` before Shiki. |
| `lib/remark-site-url.ts`, `lib/shared.ts` | `{{SITE_URL}}` and canonical site URL. |
| `app/docs/[[...slug]]/` | Docs page route. |
| `app/api/search/`, `app/og/` | Docs search and Open Graph routes. |
| `scripts/` | Docs-specific checks, including bare-domain detection. |
| `README.md` | Deployment notes. |

## Rules

- Use canonical terms from [`../../metadata/terminologies.md`](../../metadata/terminologies.md).
- Docs-specific terms: **chat**, **space**, **page**; never conversation/bundle/concept/document.
- Lead every user build task with an example ` ```prompt ` block.
- Never put Soul-editing steps in user guides: no `mkdir`, `cat > schema.yml`, git, or restarts.
- YAML and `AGENT.md` are read-only concept explanations, never instructions to type.
- Frame `~/.tulipfarm/soul` as the result of chats, not the user interface.
- Normal chat creates records/knowledge directly or loads a forge; the handoff is visible.
- Soul writes commit and reconcile live; do not tell users to restart after creation.
- Secrets and LLM-provider config are the non-agentic exception: Settings/admin UI guides are OK.
- Reader-entered assistant messages use ` ```prompt `, never ` ```text `.
- Use ` ```bash `, ` ```json `, or ` ```yaml ` only for real commands/config.
- Use ` ```text ` only for diagrams such as trees or envelopes.
- Do not route prompts through the syntax highlighter; keep `lib/remark-prompt.ts` in the MDX path.
- After changing `source.config.ts`, restart the dev server; content and `meta.json` hot-reload.
- Never write the site domain in MDX/TS/TSX; use `{{SITE_URL}}` or import `SITE_URL`.
- `scripts/site-url.test.ts` allows GitHub clone URLs but rejects bare docs-site domains.
- Anything imported by `source.config.ts` must be relative; no bare `@tulipfarm/*` specifiers.
- Keep `lib/shared.ts` import-free so Fumadocs can evaluate bundled config under plain Node.
- Verify factual claims against code first: tools, env vars, LLM behavior, ports, token prefixes.
- Never document unshipped features; use honest "not yet available" stubs.
- One reader need per page; do not mix Diátaxis quadrants.
- Guides use `meta.json` section separators, not subfolders that change `/docs/guides/<slug>`.
- Internal links must resolve to real routes; anchors must match real headings.
- Full `pnpm --filter @tulipfarm/docs build` is the check that exercises remark plugins/end-to-end.
- Design: JetBrains Mono only, no shadows, hairline borders, warm cream/near-black, ruby accent.
- Keep gradients out except the prompt block underline; clickable elements need cursor.

See [`README.md`](README.md).
