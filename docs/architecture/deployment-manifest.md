# Deployment manifest

Status: **Proposed — no code. This document is the contract to review before any of it is built.**

Scope: how TulipFarm describes its own deployment once, in a machine-readable manifest, and
renders that single description into the self-hosting documentation, an LLM-executable prompt at
`{{SITE_URL}}/deploy.txt`, and a click-through wizard at `{{SITE_URL}}/deploy`.

This document does not add an authority, write, or effect path, so the
[decision index](decision-index.md) change-control clause does not require a new ADR. It is
downstream of ADR-015 (provider selections stay behind capability-checked ports) and constrained
by ADR-019 (V1 ships no public customer CLI).

---

## 1. The problem

TulipFarm is self-hosted, so the deployment surface is the user's, not ours. They may run the
image on a VM, an Azure App Service, Container Apps, Kubernetes, or a NAS appliance, with or
without Compose. The database may be a sidecar container or a managed Postgres in another
region. Blob storage may be a filesystem volume, MinIO, Ceph, R2, or S3 proper. Domain, TLS,
secret storage, and backup are independent axes on top.

Today that knowledge lives as prose across 16 pages in
`apps/docs/content/docs/self-hosting/`. The prose is good, but it has three structural limits:

1. **It is not executable.** A user pointing an LLM at it gets an improvised deployment, because
   nothing in the page distinguishes a load-bearing value from an illustrative one.
2. **It is not enumerable.** Nothing can answer "what do we officially support?" — so nothing can
   test that the answer is still true.
3. **It cannot be re-rendered.** The same procedure cannot become a wizard without being written
   a second time, and a second copy is a copy that drifts.

The manifest exists to fix exactly those three, and nothing else. It is **not** a provisioning
tool, an infrastructure-as-code generator, or a control plane. It never touches the user's cloud.

## 2. Framing principle

**TulipFarm ships one description of its own runtime requirements. Everything a user reads,
clicks, or feeds to a model is a rendering of that description.**

```
                          deploy/contract.yml          (what TulipFarm needs, always)
                          deploy/targets/<slug>/        (how one supported platform satisfies it)
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
      self-hosting MDX       /deploy.txt          /deploy wizard
      (docs site)            (LLM path, open)     (click path, closed set)
```

The two-layer split is load-bearing. The contract is true on every platform that will ever
exist; a target is true only on one. Mixing them is how the matrix explodes, because a fact
stated per-target must be restated per-target forever.

## 3. Decisions

| ID | Decision | Consequence |
| --- | --- | --- |
| D1 | The manifest is two layers: one universal `contract.yml`, and per-target recipes that reference it | A runtime requirement is stated once. Adding a target cannot restate it. |
| D2 | Supported targets are a **closed, CI-tested set**. Everything else is explicitly unsupported | "Supported" becomes a testable claim rather than a marketing word. |
| D3 | Unsupported platforms are served by `deploy.txt` + the user's own LLM, with no promise attached | The escape hatch is honest: full configuration surface, no guarantee. |
| D4 | Prose lives **inside** the manifest as markdown fields | "Generated docs" cannot quietly mean "we deleted the why". |
| D5 | Every step carries a `verify` | A step with no check is where an LLM improvises and a wizard dead-ends. |
| D6 | The wizard **never accepts a secret value** | There is nothing to leak from a static marketing site. |
| D7 | A target emits a runnable artifact only where the platform consumes one | No Terraform-shaped fiction for platforms configured by hand. |
| D8 | Only *procedural* pages are generated; *explanatory* pages stay hand-written | Preserves the docs' voice where voice is the value. See §7.1. |

### 3.1 Supported targets at launch

| Target | Artifact it emits | Status |
| --- | --- | --- |
| `docker-compose` | rendered `docker-compose.yml` + `.env` template | Covers any VM, including an Azure VM |
| `kubernetes` | Helm `values.yaml` | — |
| `coolify` | Compose file + UI field values | — |
| `azure-container-apps` | `containerapp.yaml` | **Blocked.** See §8. |

Portainer, Dokploy, Unraid, Synology, and CasaOS consume the `docker-compose` artifact without
being separate targets — they differ in where you paste the file, not in what the file says.

## 4. Layout

Mirrors `integrations/`, which is the existing precedent in this repo for a declarative manifest
directory with a curated registry and a docs verifier.

```
deploy/
├── registry.yml                       curated presentation metadata + support tier
├── contract.yml                       the universal runtime contract
└── targets/
    ├── docker-compose/manifest.yml
    ├── kubernetes/manifest.yml
    ├── coolify/manifest.yml
    └── azure-container-apps/manifest.yml
```

Schema and validator: `packages/schema/src/deployment-manifest.ts`, alongside
`integration-manifest.ts` and exported from the package barrel.

## 5. `contract.yml`

The universal layer. Every field here is true regardless of platform.

```yaml
version: 1

services:
  - name: app
    role: API, built web UI, and migrations
    port: 8080
    health: { path: /readyz, expect: 200 }
  - name: worker
    role: Runs, waits, outbox, cron, maintenance consumers
  - name: integration-worker
    role: Slack and GitHub ingress, sync, delivery, retries, reconciliation

dependencies:
  - id: postgres
    required: true
    detail: PostgreSQL 17 with pgvector
  - id: blob
    required: true
    drivers: [filesystem, s3]        # verified against packages/storage/src/ports/

state:
  - path: /data
    holds: secrets.env, soul checkout
    durability: must survive restart and upgrade
    consequence: losing it orphans every encrypted secret in the database

env:
  - name: DATABASE_URL
    zone: required
    secret: false
  - name: ENCRYPTION_KEY
    zone: required
    secret: true
    generate: openssl rand -base64 32
    consequence: a fresh key against a populated database refuses to boot, by design
  # …
```

Three constraints on `env`:

- `zone` reuses the three zones the reference page already teaches — `required`,
  `installer-sets`, `never-set`. The manifest does not invent a fourth vocabulary.
- `secret: true` marks a value the wizard will only ever emit as a placeholder (D6).
- Every entry must resolve to a real read in the codebase (§7.2).

## 6. `targets/<slug>/manifest.yml`

```yaml
name: docker-compose
title: Docker Compose
tier: supported
summary: |
  Markdown. Who this is for and what it costs them.

inputs:                                # the wizard's questions; deploy.txt's decision points
  - id: database
    question: Where does PostgreSQL live?
    options:
      - { value: bundled,  label: Bundled container, default: true }
      - { value: managed,  label: A managed Postgres I already have }
  - id: tls
    question: How is TLS terminated?
    when: { exposed: true }

steps:
  - id: fetch-compose
    title: Download the Compose file
    body: |
      Markdown. The *why*, in TulipFarm's voice. This is the source the MDX page renders.
    run: curl -fsSLO {{SITE_URL}}/docker-compose.yml
    verify:
      kind: file
      path: docker-compose.yml
    on_fail: when-install-fails#download

  - id: bring-up
    title: Start the stack
    when: { database: bundled }
    run: docker compose up -d
    verify:
      kind: http
      url: http://localhost:8080/readyz
      expect: 200
      timeout: 120s
    on_fail: when-install-fails#readyz

artifacts:
  - id: compose
    path: docker-compose.yml
    template: templates/docker-compose.yml.hbs
```

**`verify` kinds** are a closed set — `http`, `command`, `file`, `env` — because an open set is
one an LLM can invent into. A step with no meaningful check must say `verify: { kind: manual }`
and carry the words the user should look for; it may not silently omit the field.

**`when`** is the only conditional construct, and it may only reference an `inputs` id. No
expressions. This keeps the wizard a finite state machine and keeps `deploy.txt` renderable as
flat, ordered prose.

## 7. Renderers

### 7.1 Documentation — generate procedure, not explanation

The chosen direction is manifest-as-source. Applied naively that would flatten pages like
`how-boot-modes-work` and the `docker-compose` page's secrets narrative, which are the docs'
strongest asset and are explanation rather than procedure.

**So the split is by Diátaxis type, not by page:**

| Page type | Source | Guard |
| --- | --- | --- |
| How-to (`docker-compose`, `kubernetes`, `coolify`, `azure-container-apps`) | Generated from the manifest | Regenerate in CI; a dirty diff fails |
| Reference (`environment-variables`) | Generated from `contract.yml` `env` | Same |
| Explanation (`how-boot-modes-work`, `production-checklist`, `index`) | Hand-written | `tf-claim`, as today |

Generated files carry a header comment naming their source manifest, and `.gitattributes` marks
them `linguist-generated`.

> **This is a deviation from the stated preference and needs an explicit yes or no before build.**
> Generating all 16 pages is possible; it costs the editorial voice on the pages where voice is
> the product.

### 7.2 CI fitness

The manifest is worth less than the prose it replaces unless it is provably true. Five checks,
extending mechanisms that already exist:

1. **Schema** — every manifest validates against `deployment-manifest.ts`.
2. **Env reality** — every `contract.yml` env name is read somewhere in `apps/` or `packages/`,
   and every env read in `blob-config.ts` and the boot path appears in `contract.yml`. Neither
   direction may have orphans.
3. **Docs claims** — new `docs-fitness.test.ts` verifiers `deploy-target-slugs` and
   `deploy-target-count`, exactly mirroring `integration-slugs` / `integration-count`.
4. **Generation is current** — re-render, diff, fail on drift.
5. **Boot** — every `tier: supported` target renders its artifact and boots to `/readyz` 200 in
   CI. A target that cannot be booted in CI is not `supported`; it is `community`.

Check 5 is the one that makes D2 real. Without it, "officially supported" is an assertion.

### 7.3 `deploy.txt`

A flat render of `contract.yml` plus every target, in reading order, with all `when` branches
present and labelled. Served as a static asset from the docs site, so a one-line prompt works:

```
Deploy TulipFarm for me. Follow this guide: {{SITE_URL}}/deploy.txt
```

It states its own trust boundary in the opening lines: which targets are verified, that anything
else is unverified, and that the model must run each `verify` before proceeding rather than
assuming success. Verification is what separates this from a model reading the docs.

### 7.4 The `/deploy` wizard

A client-only route in `apps/docs`. Renders `inputs` as steps, `steps` as instructions,
`artifacts` as a downloadable file. Offers **only** `tier: supported` targets, and routes every
other platform to `deploy.txt` rather than guessing.

Per D6 it accepts no secret. Where a secret is required it emits a placeholder plus the
`generate` command from `contract.yml`, to be run on the user's own machine. Nothing is
transmitted; the page needs no server, which is also why it can be statically hosted.

## 8. Prerequisite: the Azure Blob driver

`packages/storage/src/ports/` ships two blob drivers, `filesystem-blob.ts` and `s3-blob.ts`.
Azure Blob Storage exposes no S3-compatible API, so today an Azure deployment must either mount a
persistent volume — which Container Apps and App Service do not offer with the required
durability — or use non-Azure object storage.

`azure-container-apps` therefore cannot be a `supported` target until `azure-blob.ts` exists and
passes `packages/storage/src/ports/blob-conformance.ts`. That suite bounds the work and defines
done. The addition is consistent with ADR-015 and needs no new decision.

This is the manifest earning its keep before a line of it is written: forcing an enumeration of
what is supported surfaced a missing capability that prose had left implicit.

## 9. Explicit non-goals

- **No provisioning.** TulipFarm never holds a cloud credential or calls a cloud API.
- **No CLI.** ADR-019 stands; the renderers are a static file and a static page.
- **No telemetry from the wizard.** It is a static page that reports nothing back.
- **No community-target promises.** A `tier: community` manifest may exist and is rendered into
  docs, but never appears in the wizard and carries no CI boot test.

## 10. Build order

Each stage is independently valuable, and each is a place to stop.

| # | Stage | Proves |
| --- | --- | --- |
| 1 | Schema + `contract.yml` + the env-reality check (§7.2 #2) | The contract is real and provably matches the code |
| 2 | `docker-compose` target + generated MDX + boot test | The whole pipeline works end to end on one target |
| 3 | `deploy.txt` renderer | The LLM path, on a proven manifest |
| 4 | Remaining targets: `kubernetes`, `coolify` | The schema survives contact with a second and third shape |
| 5 | `/deploy` wizard | The click path |
| 6 | `azure-blob.ts` → `azure-container-apps` | Azure, honestly |

Stage 1 alone is worth building even if nothing after it ships: an enumerated, CI-verified
contract of what TulipFarm needs to run is the artifact this whole design is actually about.
