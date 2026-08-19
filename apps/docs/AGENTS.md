# Docs site

`@tulipfarm/docs` is the public Fumadocs site on Next.js, built as a static export.
It owns docs content, MDX rendering, prompt blocks, install snippets, and site styling.

**Writing or restructuring content? Load `.agents/skills/tulipfarm-docs/` first** — it carries the
voice bar, the Diátaxis quadrant test, and the per-track writing mode. This file is the map and
the binding local rules only.

## Read on / Skip

- **Read on if** your task changes public docs, MDX components, Fumadocs config, install
  snippets, docs search/OG routes, or docs-only style.
- **Skip if** you are changing product UI, API, worker, or `docs/architecture/` — each owns its
  own `AGENTS.md`.

## Map

Three reader tracks plus two shared sections. A page belongs to the track whose *access level*
it needs, never the one whose topic it resembles.

| Path | Owns |
| --- | --- |
| `content/docs/index.mdx` | The three-track chooser. Every reader lands here. |
| `content/docs/self-hosting/` | Running the server: install, deploy, TLS, backup, upgrade. |
| `content/docs/administration/` | Configuring the instance: models, credentials, people, integrations. |
| `content/docs/using-tulipfarm/` | Building and running work by chat. No admin access, ever. |
| `content/docs/reference/`, `content/docs/security/` | Shared lookup: env vars, commands, API, roles, security. |
| `content/docs/*/meta.json` | Nav order and `---Separator---` group headings. |
| `source.config.ts`, `components/mdx.tsx` | Fumadocs config, remark plugins, MDX component map. |
| `components/prompt-block.tsx`, `lib/remark-prompt.ts` | The ` ```prompt ` block and the remark plugin that builds it. |
| `lib/remark-site-url.ts`, `lib/shared.ts` | `{{SITE_URL}}`, site URL, site description. |
| `app/docs/[[...slug]]/` | Docs page route and per-page SEO metadata. |
| `app/sitemap.ts`, `app/robots.ts`, `app/og/` | Sitemap, robots policy, Open Graph images. |

## Rules

- **No page under `using-tulipfarm/` may require admin access**, or contain `/api/v1/` paths, repo
  source paths, or shell fences. Describe the screen; put the detail in `reference/`. Enforced by
  `scripts/docs-fitness.test.ts` against `ADMIN_ONLY_SURFACES` in `../api/src/identity/roles.ts`,
  via the `tf-page` MDX comment each such page carries — never HTML, which MDX cannot parse.
- Internal type names (`ModelProfile`, `ToolContract`) are not product words — use plain English,
  but grep `apps/web` first: `SkillAudit` is a real button label, so it stays.
- Writing mode is **per track**, not universal:
  - `using-tulipfarm/` — **prompt-first**. Lead every build task with a ` ```prompt ` block.
  - `administration/` — **screen-first**. Lead with the UI path, e.g. **Operate → Business → Secrets**.
  - `self-hosting/` — **terminal-first**. Lead with the command.
- Slugs: verb-led how-to (`connect-slack`), noun-led explanation (`how-chat-works`), bare-noun
  reference (`environment-variables`). Never name the reader — write "you", never "as an admin".
- Use canonical terms from [`../../metadata/terminologies.md`](../../metadata/terminologies.md).
  Docs-specific: **chat**, **space**, **page**; never conversation/bundle/concept/document.
- Never put Soul-editing steps in user guides: no `mkdir`, `cat > schema.yml`, git, or restarts.
- YAML and `AGENT.md` are read-only explanations, never instructions to type. Frame
  `~/.tulipfarm/soul` as the result of chats. Soul writes reconcile live — never say "restart".
- Secrets and LLM-provider config are the non-agentic exception: admin UI steps are correct there.
- Verify every claim against code: tools, env vars, LLM behavior, ports, token prefixes. Pin a
  number with `tf-claim`. Never document unshipped features. One reader need per page.
- Reader-entered assistant messages use ` ```prompt `, never ` ```text `.
- ` ```bash `/` ```json `/` ```yaml ` only for real commands or config; ` ```text ` only for
  diagrams. Never route prompts through the highlighter.
- **Put a `##` heading before every `<Steps>` and `<Cards>` block.** Both render `h3` internally,
  so without it the page jumps `h1 → h3` and fails accessibility checks.
- Registered: `Callout`, `Cards`/`Card`, `Steps`/`Step`, `File`/`Folder`/`Files`,
  `Accordion`/`Accordions`, `Banner`, `PromptBlock`. Adding one needs a reason.
- Frontmatter needs `title` and a 110–160 character `description` — it is the search snippet.
- The canonical site URL is `https://tulipfarm.site`, set once in `lib/shared.ts`. Never write
  the domain in MDX/TS/TSX — use `{{SITE_URL}}` or import `SITE_URL`.
- Imports in `source.config.ts` must be relative, and `lib/shared.ts` must stay import-free, so
  Fumadocs can evaluate bundled config under plain Node. Restart dev after editing it.
- Design: JetBrains Mono only, no shadows, hairline borders, warm cream/near-black, ruby accent,
  no gradients except the prompt block underline; clickable elements need cursor.

## Checks

```bash
pnpm docs:test                        # links, nav, frontmatter, the admin invariant
pnpm --filter @tulipfarm/docs build   # exercises remark plugins end to end
```

Deployment notes: [`README.md`](README.md).
