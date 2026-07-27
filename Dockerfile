# syntax=docker/dockerfile:1
# Single TulipFarm app image (ARCH-V1-006): Fastify serves the API + the built
# web SPA + in-process pg-boss workers. Multi-arch (amd64/arm64). Postgres-only.
#
# Slim runtime: the API + workspace TS packages are esbuild-bundled into one
# server.cjs (no tsx, no source), and only the prod dependency closure (via
# pnpm deploy) ships — the dev toolchain (vite/remix/turbo/typescript/biome/
# vitest/esbuild) is left in the build stage.

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
# The csp-hash Vite plugin extracts inline-script SHA-256 hashes from index.html
# and writes the full CSP header to build/client/.csp-header.txt (SEC-V1-002).
RUN VITE_API_URL="" pnpm --filter @tulipfarm/web build
# Bundle the API + workspace packages into one file. Native modules and packages
# that read their own files at runtime (scalar UI assets) stay external and are
# supplied by the prod deploy closure below. The datastore driver (pg) and queue
# (pg-boss) are externalized too — they live in the prod node_modules closure.
RUN TF_VERSION=$(node -p "require('./package.json').version") \
  && pnpm --filter @tulipfarm/api exec esbuild src/index.ts \
  --bundle --platform=node --target=node26 --format=cjs --outfile=dist/server.cjs \
  --define:__TULIPFARM_VERSION__="\"$TF_VERSION\"" \
  --external:isolated-vm --external:@node-rs/argon2 --external:pg --external:pg-boss \
  --external:@scalar/fastify-api-reference \
  && pnpm --filter @tulipfarm/api exec esbuild src/hooks/hook-worker.ts \
  --bundle --platform=node --target=node26 --format=cjs --outfile=dist/hook-worker.cjs \
  --external:isolated-vm --external:pg
# Prod-only dependency closure (drops dev deps, resolves transitive deps flat).
RUN pnpm --filter @tulipfarm/api deploy --prod --legacy /deploy

FROM node:26.5.0-slim AS runtime
# git: soul backup/sync shells out to it. ca-certificates: git clones soul
# remotes over https; --no-install-recommends skips it, so name it explicitly.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    SOUL_PATH=/opt/tulipfarm/soul \
    WEB_DIST=/app/apps/web/build/client
COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist/server.cjs ./server.cjs
# Hook sandbox worker — spawned as a sibling file by HookExecutor (worker_threads
# can't run code out of the server.cjs bundle).
COPY --from=builder /app/apps/api/dist/hook-worker.cjs ./hook-worker.cjs
COPY --from=builder /app/apps/web/build/client ./apps/web/build/client
COPY --from=builder /app/skills ./skills
RUN mkdir -p /opt/tulipfarm/soul
# Drop root: the app shells out to git (soul sync) and runs isolated-vm — no need for root.
# node:26.5.0-slim ships a `node` user; give it the app + soul dirs it writes to.
RUN chown -R node:node /app /opt/tulipfarm
USER node
EXPOSE 8080
CMD ["node", "server.cjs"]
