# syntax=docker/dockerfile:1
# Single TulipFarm app image: Fastify serves the API + the built
# web SPA + in-process pg-boss workers. Multi-arch (amd64/arm64). Postgres-only.
#
# Slim runtime: the API + workspace TS packages are esbuild-bundled into one
# server.cjs (no tsx, no source), and only the prod dependency closure (via
# pnpm deploy) ships — the dev toolchain (vite/remix/turbo/typescript/biome/
# vitest) is left in the build stage. esbuild is the exception: the API compiles
# agent-authored Surface code views with it at run time, so it ships too.

FROM node:26.5.0-slim AS builder
WORKDIR /app
ENV CI=true
# Build toolchain for native deps (isolated-vm, @node-rs/argon2). git: the root
# `prepare` lifecycle script runs `lefthook install`, which shells out to git.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*
# node:*-slim no longer bundles corepack by default; install it explicitly.
RUN npm install -g corepack@latest && corepack enable
COPY . .
# The root `prepare` lifecycle script runs `lefthook install`, which shells out to
# git and needs a repo — but `.git` is dockerignored. A throwaway repo (builder stage
# only; never copied to runtime) lets `prepare` succeed without bloating the context.
RUN git init -q
RUN pnpm install --frozen-lockfile
# VITE_API_URL="" makes the built SPA use relative URLs — correct when the API
# serves the SPA from the same origin (single-image mode on port 8080).
# The dev fallback in api.ts (localhost:4010) must NOT be baked into the image.
# The completed web build extracts inline-script SHA-256 hashes from index.html
# and writes the full CSP header to build/client/.csp-header.txt (SEC-V1-002).
RUN VITE_API_URL="" pnpm --filter @tulipfarm/web build
# The runtime API fails closed when WEB_DIST is enabled; keep the image build equally strict so
# packaging can never silently omit the hash-based CSP artifact.
RUN test -s /app/apps/web/build/client/.csp-header.txt \
  && grep -Eq "script-src[^;]*'sha256-" /app/apps/web/build/client/.csp-header.txt \
  && ! grep -Eq "script-src[^;]*'unsafe-inline'" /app/apps/web/build/client/.csp-header.txt
# Bundle the API + workspace packages into one file. Native modules and packages
# that read their own files at runtime (scalar UI assets) stay external and are
# supplied by the prod deploy closure below. The datastore driver (pg) and queue
# (pg-boss) are externalized too — they live in the prod node_modules closure.
# The Subscription Providers' packages must stay external as well: each locates a native binary by
# resolving its own package from disk, which bundling into a single .cjs destroys.
RUN TF_VERSION=$(node -p "require('./package.json').version") \
  && pnpm --filter @tulipfarm/api exec esbuild src/index.ts \
  --bundle --platform=node --target=node26 --format=cjs --outfile=dist/server.cjs \
  --define:__TULIPFARM_VERSION__="\"$TF_VERSION\"" \
  --external:isolated-vm --external:@node-rs/argon2 --external:pg --external:pg-boss \
  --external:@scalar/fastify-api-reference --external:@anthropic-ai/claude-agent-sdk \
  --external:@openai/codex --external:esbuild \
  && pnpm --filter @tulipfarm/api exec esbuild src/hooks/hook-worker.ts \
  --bundle --platform=node --target=node26 --format=cjs --outfile=dist/hook-worker.cjs \
  --external:isolated-vm --external:pg
# The durable worker: a second long-running entrypoint off the same image, so one image tag
# always pairs an API with a worker that speaks the same schema. This is the process that runs
# the AgentLoop, so the Subscription Provider externalizations matter most here.
RUN pnpm --filter @tulipfarm/worker exec esbuild src/main.ts \
  --bundle --platform=node --target=node26 --format=cjs --outfile=dist/worker.cjs \
  --external:pg --external:pg-boss --external:isolated-vm \
  --external:@anthropic-ai/claude-agent-sdk --external:@openai/codex \
  && pnpm --filter @tulipfarm/worker exec esbuild src/hooks/ingress-hook-worker.ts \
  --bundle --platform=node --target=node26 --format=cjs --outfile=dist/ingress-hook-worker.cjs \
  --external:isolated-vm
# The integration worker: a third long-running entrypoint off the same image. Boot skeleton only
# today — no consumer loop is registered yet — but ships alongside the API and worker so schema
# agreement is never a deploy-ordering problem.
RUN pnpm --filter @tulipfarm/integration-worker exec esbuild src/main.ts \
  --bundle --platform=node --target=node26 --format=cjs --outfile=dist/integration-worker.cjs \
  --external:pg
# Prod-only dependency closure (drops dev deps, resolves transitive deps flat).
RUN pnpm --filter @tulipfarm/api deploy --prod --legacy /deploy
# The claude-code Subscription Provider spawns a native `claude` binary that ships in an optional,
# per-platform package (@anthropic-ai/claude-agent-sdk-linux-{x64,arm64}) — there is no
# node_modules/.bin/claude, and pnpm keeps it under .pnpm rather than hoisting it. `--prod` prunes
# aggressively and optional deps are exactly the kind of thing it can drop, so assert both that the
# SDK resolves from the deploy root (the esbuild bundles `require` it as an external) and that the
# binary survived for this image's arch — rather than discovering either at the first chat turn.
# Same fail-closed discipline as the CSP artifact check above.
RUN cd /deploy && node -e "require.resolve('@anthropic-ai/claude-agent-sdk')"
RUN set -eu; \
  bin=$(ls /deploy/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*/node_modules/@anthropic-ai/*/claude 2>/dev/null | head -n1); \
  test -n "$bin"; \
  test -x "$bin"
# Same two checks for the codex Subscription Provider. Its launcher (bin/codex.js) is resolved at
# runtime from the running entrypoint, so it must resolve from /deploy; the launcher then execs a
# statically linked musl binary out of an optional per-platform package, which --prod can likewise
# drop. The vendor triple is globbed rather than named so an arch rename fails loudly here.
# esbuild compiles agent-authored Surface code views at authoring time, so it is a runtime
# dependency, not part of the pruned dev toolchain. It resolves its own per-platform binary
# (@esbuild/linux-{x64,arm64}) out of node_modules — an optional dep, the same class --prod can
# drop — so assert both, for the same reason as the two Providers above.
RUN cd /deploy && node -e "require.resolve('esbuild')"
RUN test -x /deploy/node_modules/esbuild/bin/esbuild

RUN cd /deploy && node -e "require.resolve('@openai/codex/package.json')"
RUN set -eu; \
  bin=$(ls /deploy/node_modules/.pnpm/@openai+codex@*/node_modules/@openai/codex/vendor/*-unknown-linux-musl/bin/codex 2>/dev/null | head -n1); \
  test -n "$bin"; \
  test -x "$bin"

FROM node:26.5.0-slim AS runtime
# git: soul backup/sync shells out to it. ca-certificates: git clones soul
# remotes over https; --no-install-recommends skips it, so name it explicitly.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    SOUL_PATH=/opt/tulipfarm/soul \
    TF_DATA_DIR=/data \
    WEB_DIST=/app/apps/web/build/client
COPY --from=builder --chown=node:0 /deploy/node_modules ./node_modules
COPY --from=builder --chown=node:0 /app/apps/api/dist/server.cjs ./server.cjs
# Hook sandbox worker — spawned as a sibling file by HookExecutor (worker_threads
# can't run code out of the server.cjs bundle).
COPY --from=builder --chown=node:0 /app/apps/api/dist/hook-worker.cjs ./hook-worker.cjs
# Durable worker entrypoint. Not the image CMD — compose runs it as its own service off this
# same image, so the API and the worker can never drift out of schema agreement.
COPY --from=builder --chown=node:0 /app/apps/worker/dist/worker.cjs ./worker.cjs
# The worker's own hook sandbox entrypoint. Deliberately a different basename from the API's: both
# land in this directory, and sharing one would hand an Integration's classifier the API's grant.
COPY --from=builder --chown=node:0 /app/apps/worker/dist/ingress-hook-worker.cjs ./ingress-hook-worker.cjs
# Integration worker entrypoint. Not the image CMD — compose runs it as its own service off this
# same image, mirroring how `worker.cjs` is run.
COPY --from=builder --chown=node:0 /app/apps/integration-worker/dist/integration-worker.cjs ./integration-worker.cjs
COPY --from=builder --chown=node:0 /app/apps/web/build/client ./apps/web/build/client
COPY --from=builder --chown=node:0 /app/skills ./skills
COPY --from=builder --chown=node:0 /app/integrations ./integrations
# /data holds the bootstrap secrets generated on first boot when the operator supplies none
# (and, later, backups) — it must be a mounted volume or those keys die with the container.
#
# Ownership of /app is set by `--chown` on each COPY above rather than by a recursive chown here.
# A `chown -R` over /app rewrites the metadata of every file in the prod dependency closure, and
# Docker's copy-on-write then duplicates all ~700MB into a fresh layer — twice over, once per
# recursive pass. Setting it at copy time costs nothing and is what keeps this image under 2GB.
#
# /app is deliberately NOT made group-writable: nothing writes under it at runtime (TF_DATA_DIR
# and SOUL_PATH point elsewhere), and its 0644/0755 modes already let an arbitrary UID in group 0
# read and traverse it. Only the two genuinely writable trees get the OpenShift treatment below,
# and both are empty at this point, so the recursive pass over them is free.
#
# Drop root: the app shells out to git (soul sync) and runs isolated-vm — no need for root.
# node:26.5.0-slim ships a `node` user. OpenShift (and any platform using `runAsUser` with a
# random UID) ignores USER and runs as an arbitrary uid in group 0, so the writable trees are
# group-owned by root and group-writable — that keeps them writable in that case without
# granting anything to other users.
RUN mkdir -p /opt/tulipfarm/soul /data \
  && chown node:0 /app \
  && chown -R node:0 /opt/tulipfarm /data \
  && chmod -R g=u /opt/tulipfarm /data
USER node
EXPOSE 8080
CMD ["node", "server.cjs"]
