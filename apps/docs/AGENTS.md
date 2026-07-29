# Docs Site — Agent Conventions

`@tulipfarm/docs` — the public documentation site. [Fumadocs](https://fumadocs.dev) on
Next.js, **static export** (`next build` → `out/`). Dev on `:4020`. See root `AGENTS.md`
for monorepo commands, Biome rules, and git policy; see `README.md` for deployment.

> **Terminology is binding** — [`metadata/terminologies.md`](../../metadata/terminologies.md).
> In these docs that means: **chat** (never "conversation"), **space** / **page** (never
> bundle/concept/document/collection), and user-created Agents by their display names.

## The one rule that governs everything here

**TulipFarm is built by chatting, so the docs lead with prompts, not files.** A user
describes what they want and agents build it — they do not edit YAML or run git. Write
every build task that way:

- **Lead with an example prompt**, in a ` ```prompt ` block (see below). "Ask the
  assistant: *Create a customer resource type with a name and an email.*"
- **Never put a soul-editing procedure in a user guide** — no `mkdir`/`cat > schema.yml`/
  `git commit`/restart walls. That is operator territory and reads as "this is how you do
  it," which is wrong.
- **YAML/`AGENT.md` appears only as read-only explanation** on *concept* pages ("here is
  what the assistant writes underneath"), never as a step a reader is told to type.
- The **soul** (`~/.tulipfarm/soul`, a git repo) is the *result* of those chats, not the
  interface. Frame it that way.

### How building actually works (verify against `apps/api/src/soul/agents/platform-agents.ts`)

 - Normal chat answers, reads, and creates **records + knowledge** directly, and loads a **forge**
  (`resource-forge` / `agent-forge` / `skill-forge` / `onboarding`) to build the system.
  and writes the artifact. The handoff is visible to the user.
- Soul writes commit immediately and reconcile **live — no restart** (`create_resource_type`
  calls `soulLoader.reload()` + `reconcile()`).
- **The only non-agentic exception:** secrets and LLM-provider config are set in **Settings**
  (admin UI), not by chat. Those guides stay UI/CLI-based — do not force prompts onto them.

## The `prompt` block

Any message a reader would type to the assistant goes in a ` ```prompt ` fenced block — it
renders with an AI icon, a "Prompt" label, a copy button, and a warm gradient underline,
marking it as a prompt rather than runnable code. Use ` ```bash `/` ```json `/` ```yaml `
for real commands/config and ` ```text ` only for diagrams (the soul tree, the encryption
envelope) — **never ` ```text ` for a prompt.**

How it works — do not route prompts through the syntax highlighter:

- `lib/remark-prompt.ts` — remark plugin that rewrites ` ```prompt ` code nodes into
  `<PromptBlock>` at the mdast stage, before Shiki ever sees the unknown `prompt` language.
- `components/prompt-block.tsx` — the rendered component.
- Wired in `source.config.ts` (`mdxOptions.remarkPlugins`) and `components/mdx.tsx`
  (component map). **Changing `source.config.ts` requires a dev-server restart** (content
  `.mdx`/`meta.json` edits hot-reload; build config does not).

## Never write the site domain — use `{{SITE_URL}}`

Install commands point at the docs site itself (`https://tulipfarm.site/install.sh`), which
also serves `uninstall.sh`, `docker-compose.yml`, `install.ps1`, and `env.example`. The
domain lives in exactly one place: `SITE_URL` in `lib/shared.ts`.

In MDX, write the token — `lib/remark-site-url.ts` substitutes it at the mdast stage, so
fences stay real ` ```bash ` blocks with highlighting and a copy button:

````md
```bash
curl -fsSL {{SITE_URL}}/install.sh | sudo bash
```
````

It works in prose, inline code, and link URLs too. In `.ts`/`.tsx`, import
`SITE_URL` from `@/lib/shared`. `scripts/site-url.test.ts` fails the build on a bare
domain in any `.ts`, `.tsx`, or `.mdx` file. A `git clone` URL is different — that is
GitHub, and stays spelled out.

**Anything `source.config.ts` imports must use relative paths only.** fumadocs-mdx bundles
that file with esbuild into `.source/source.config.mjs`, which plain Node then evaluates
*outside* webpack. esbuild inlines relative imports but leaves bare specifiers external, so
a `@tulipfarm/*` import there has to be resolved at runtime, where `transpilePackages` does
not apply — it fails with `Cannot find package`. This is why `SITE_URL` is defined in this
app rather than pulled from a shared package, and why `lib/shared.ts` has no imports of its
own. Keep any new remark plugin free of bare workspace specifiers.

## Accuracy is non-negotiable

Documentation that lies is worse than none. Before writing any factual claim:

- **Verify it against the code** — tool names in `apps/api/src/**/tools.ts`, LLM behavior in
  `packages/llm/src`, env vars at their `process.env` read sites, ports in app configs.
  Copy names exactly (`tulip_` token prefix, not `tf_`; four provider integrations, not
  "55+").
- **Never document an unshipped feature.** When a section is still an empty-state
  placeholder in the app, its guide is an honest "not yet available" stub, not an invented
  how-to (Routines lived as such a stub until v0.11 shipped). If a feature isn't in the
  code, it isn't in the docs.

## Structure (Diátaxis)

One reader-need per page; do not mix quadrants.

| Section | Quadrant | Notes |
| --- | --- | --- |
| `concepts/` | Explanation | How/why. Links out to guides for steps; never numbered procedures. |
| `guides/` | How-to | Task recipes. Build tasks are prompt-first. |
| `reference/` | Reference | Env vars, commands — complete and neutral. |
| `security/` | Reference + explanation | Encryption, hashing. |

- **Guides are grouped with `meta.json` section separators** (`"---Setup---"` etc.), **not
  subfolders** — subfolders change `/docs/guides/<slug>` URLs and break every inbound link.
- Register any new custom MDX component in `components/mdx.tsx`.
- Internal links must resolve to a real route; anchors to a real heading.

## File map

| Path | What |
| --- | --- |
| `content/docs/**/*.mdx` | The docs. `meta.json` per folder sets nav order + separators. |
| `source.config.ts` | Fumadocs MDX config — frontmatter schema + `remarkPlugins`. |
| `components/mdx.tsx` | MDX component map (`getMDXComponents`) — register components here. |
| `components/prompt-block.tsx` | The `prompt` block component. |
| `lib/remark-prompt.ts` | ` ```prompt ` → `<PromptBlock>` transform. |
| `app/docs/[[...slug]]/page.tsx` | Docs page renderer. |

## Verify before done

```bash
pnpm --filter @tulipfarm/docs lint        # biome
pnpm --filter @tulipfarm/docs typecheck   # fumadocs-mdx + next typegen + tsc (validates MDX + frontmatter)
pnpm --filter @tulipfarm/docs build        # static export — RUNS the remark plugin; the true test
```

The full `build` is the only check that exercises ` ```prompt ` transforms and `meta.json`
separators end-to-end. Grepping `out/` HTML confirms a component actually rendered.

## Design language

Mirrors the web app (see `app/global.css`, mapped onto fumadocs tokens): **JetBrains Mono
only, no shadows, hairline borders, warm cream/near-black palette, ruby (`--color-fd-primary`)
as the sole brand accent.** The prompt block's warm ruby→amber gradient underline is the one
deliberate exception — keep gradients out of everything else. Add `cursor-pointer` to every
clickable element.
