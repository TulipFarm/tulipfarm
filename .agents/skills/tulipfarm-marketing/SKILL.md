---
name: tulipfarm-marketing
description: Design and write TulipFarm's public landing pages. Use when creating a marketing page, changing landing-page copy or interactions, choosing visual directions, or separating the public website from apps/docs.
---

# TulipFarm Marketing

Build around a small product experience, with a distinct tulip identity. A visitor should
understand what they can build, see the result, and reach guided self-hosted setup.

## Workflow

1. Read `AGENTS.md`, `DESIGN.md`, and `metadata/terminologies.md`, then the owning app's
   `AGENTS.md`. The marketing workspace is `apps/www`; documentation belongs to `apps/docs`.
2. Preserve the settled requirements below, not the last draft's layout. Inspect live references,
   including lower-page sections and interactions. When offering alternatives, present at most
   two concrete options and wait for the choice. An explicit request to fix or rework a design
   authorizes a coherent revision; do not restart a questionnaire about every styling decision.
3. Define the page's visitor need and primary action. Map each product claim and demonstration
   to shipped behavior. Resolve unsupported claims before writing final copy.
4. Compose the request-to-result story before adding decoration. Use real product components,
   captures, or recordings; identify demonstrations as examples. Each section must answer a
   different visitor question rather than repeat the opening demo.
5. Implement the selected design with the existing workspace tools. Read dependency manifests
   before choosing libraries. Keep external references in the design discussion; describe
   TulipFarm's own rules in code and documentation.
6. Follow the root verification policy. When visual verification is in scope, inspect narrow
   and wide screens, keyboard interaction, reduced motion, and every primary-action destination.
   Finish only when the interaction depicted and the interaction delivered agree.

## Settled requirements

| Part | Decision |
| --- | --- |
| Opening | A concise business promise and a focused product experience. No fixed alignment or section template. |
| Identity | Soft tulip-inspired shapes and playful agent identities, without a cartoon treatment. |
| Message | Build business operations through chat, then let agents run the work. |
| Main action | **Start building**, leading to guided self-hosted setup, not a sales request. |
| Product explanation | Useful business jobs shown through requests and results, not a feature catalogue. |
| Colour | A light canvas, dark text, ruby actions, and small colourful details rather than large colour panels. |
| Motion | Purposeful transitions that explain building, a handoff, or a result, with a useful static alternative. |

Draft copy seed, not final wording:

> Build your operations by chatting.
>
> Describe what your business needs. Turn it into a working system, then let agents run it.

## Approved stack

- **Workspace:** `apps/www`, separate from the documentation app.
- **Framework:** Next.js with React, TypeScript, and Tailwind CSS. Use `output: "export"`;
  build the pages as static files and isolate interactive components on the client.
- **Hosting:** Cloudflare Pages. Do not substitute Cloudflare Workers or introduce
  request-time server rendering, Server Actions, or a Next.js server dependency.
- **Content:** Versioned files in this repository, published through the site build.
  No external CMS.
- **Demo:** A prepared, interactive browser experience with fixed sample data. No live
  agent requests, model calls, or demo backend. Keep the example label visible.

## Product story and copy

- Lead with something a person wants done. Introduce agents, resource types, knowledge, and
  routines when they help explain that result; use the canonical names.
- Candidate examples include tracking customers and creating a support agent. Verify the
  complete demonstrated path before publishing either; a plausible prompt is not product proof.
- Offer a few concrete example choices. Selecting one must change the replay and its result.
  A preset replay must not look like a live, free-form agent that accepts arbitrary requests.
- Keep the installation command out of the opening visual. The primary button takes visitors
  to the supported setup journey; the preview helps them understand why they would start.
- Write short, direct copy. Use the same button label for the same action across the page.
- Ground trust in demonstrable controls, working examples, and inspectable evidence. Publish
  customer names, testimonials, statistics, and performance claims only with verified support.
  Visual references are not evidence of conversion performance.
- Keep the deeper connected-system explanation on a dedicated product page if one is needed.
  The homepage should remain useful without requiring a reader to learn the architecture.

## Visual and interaction rules

- Preserve the wordmark and ruby identity. The product/docs rules for compact controls, closed
  colour axes, restrained depth, and work-state-only motion are not the marketing visual brief.
  Keep website tokens in its own CSS and leave product and documentation tokens alone.
- Judge the complete page: the opening, transitions between sections, product proof, and closing.
  Vary composition, scale, and density. Repeated text/panel rows are not a full-page direction.
- Do not promote a draft's font, radius, spacing, or layout into a permanent rule. Record stable
  brand and behavior requirements; let visual choices remain revisable.
- Concentrate colour in actions and small original illustrations. Give tulip shapes a clear
  role, such as distinguishing the agents in an example, rather than decorating every section.
- Let product content carry the demo. Use actual interface states rather than fabricated
  dashboards or borrowed screenshots. An explanatory diagram must read as a diagram.
- Judge the opening as a complete composition, not a collection of correct components. Use a
  clear product scene rather than a small field card surrounded by explanatory labels.
- When a choice between options is pending, get an explicit choice. Approval of one mockup is
  not blanket approval of every later section or a reason to preserve choices the user rejects.
- Keep the promise, explanation, and main button visible on the initial desktop screen.
  Avoid a giant dashboard image that makes the visitor hunt for the relevant result.
- Make example selectors keyboard-operable with a clear selected state. Preserve a readable
  result without animation; respect reduced motion and provide controls for replaying media.
- Use a static first frame while media loads. Reserve its space, keep assets local, and provide
  an explicit error state if an interactive preview cannot load.
- Prepared examples use the real `@tulipfarm/surface-web/view` renderer. Validate their Artifacts
  at build time and pass serialized public data to the client; never import runtime validation
  or backend dependencies into the interactive leaf.
- Collapse multi-column stories deliberately on small screens. Keep product text legible
  rather than shrinking an entire desktop interface to fit.
- Use references for principles, not copied artwork, page text, or a transplanted brand.

## Public-site separation

Apply this branch when extracting the website or changing public URLs:

- Put public landing pages in `apps/www` at `https://tulipfarm.site`. Keep
  documentation in `apps/docs` at `https://docs.tulipfarm.site`.
- Read `apps/docs/README.md` and `packages/constants/AGENTS.md` before changing origins.
  Separate the marketing and documentation origins at their shared source of truth.
- Preserve published installer, uninstall, Compose, environment-example, deployment-guide,
  and schema URLs. A docs-origin change must not silently change the installer distribution
  origin or turn a machine-readable download into an HTML redirect page.
- Map old documentation URLs to their new destinations and configure permanent redirects.
  Preserve useful paths and anchors; verify cross-site navigation in both directions.
- Account for canonical URLs, social images, sitemaps, robots, search, `llms.txt`, generated
  content, public assets, and deployment configuration. Hosting and DNS changes require
  separate execution; a local code change does not mean either domain has moved.
- Give the new workspace an `AGENTS.md` and update the root map and directly affected docs.
  Load `tulipfarm-docs` before changing documentation content or its conventions.
