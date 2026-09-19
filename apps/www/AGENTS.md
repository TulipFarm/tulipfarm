# Public website

`@tulipfarm/www` owns public landing pages and guided deployment. It is a Next.js static export
for Cloudflare Pages, not a Next.js server or Worker.

## Read on / Skip

- **Read on if** you change public copy, examples, conversion paths, deployment entry, or website hosting.
- **Skip if** you change documentation content (`../docs`) or the product UI (`../web`).

## Map

| Path | Owns |
| --- | --- |
| `app/page.tsx`, `app/global.css` | Homepage story, local-font typography, light ruby-led website tokens. |
| `components/business-demo.tsx` | Illustrated request-to-result flow, prepared example selection/playback, and optional real UI captures. |
| `components/product-preview.tsx` | Shared client boundary and explicit failure state for Surface Web previews. |
| `lib/examples.ts` | Fixed public sample data and capture paths; Artifacts validated at build time. |
| `lib/site.ts` | Marketing/docs origin helpers; origins come from the constants package. |
| `components/site-chrome.tsx` | Shared navigation, one Start building action, and footer. |
| `app/deploy/` | Host choices, assistant prompt, and manifest-driven setup; no secrets or runtime requests. |
| `app/not-found.tsx`, `app/opengraph-image.png/` | Recovery navigation and the build-time social image. |
| `scripts/`, `public/` | Build-time distribution files and Cloudflare Pages headers/redirects. |
| `public/fonts/`, `public/images/examples/` | Licensed marketing type and cropped local product captures; see README for provenance. |
| `test/` | Browser acceptance against exported pages, not component implementation state. |

## Rules

- Load `../../.agents/skills/tulipfarm-marketing/SKILL.md` for website design and copy.
- Follow the marketing brief, not product/docs control geometry or motion limits. Preserve the
  light canvas, dark text, ruby identity, accessibility, and truthful sample labels.
- The examples use the real Surface Web renderer with clearly labelled prepared data. Never call
  a model, product API, analytics service, or remote demo backend from them.
- Import `lib/examples.ts` only on the server/build side; client leaves import its types only.
- Replay is user-initiated, cancels on example selection, and is immediate with reduced motion.
- Show the customer result on entry; selecting an example shows its result. Replay and reset start
  at Describe. The static result must remain useful without JavaScript.
- Controls stay disabled until hydration. Failed scripts leave a readable static preview and
  recovery guidance, not apparently active controls or an endless loader.
- Preload local captures so example selection and opening the real UI disclosure make no requests.
  Failed captures show an explicit error; the request and real result remain readable.
- No cross-app imports. Reuse public package boundaries; never bring Fumadocs into this app.
- Deployment text must be copied after export: Next's `/deploy` RSC payload also uses `deploy.txt`.
- Setup controls stay disabled before hydration. Static recovery links and the copyable prompt
  remain readable without scripts; clipboard failures show a visible manual-copy instruction.
- Use relative website navigation and absolute docs links. Installers stay on the website origin.
- Reading links start at the docs origin's `/`, not `/docs`; keep `/llms.mdx/docs/*` and `/og/docs/*` stable.
- Import icons through `components/icons.tsx`, using individual `reicon-react/icons/*` entrypoints.

See [README](README.md) for Cloudflare Pages build and cutover requirements.
