FROM node:26-slim AS build
RUN npm install --global pnpm@11.5.3
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
# Filtered installs may not include every patched package; the full install stays strict.
RUN printf '\nallowUnusedPatches: true\n' >> pnpm-workspace.yaml
RUN pnpm fetch
COPY packages/ packages/
COPY apps/worker/ apps/worker/
RUN pnpm install --offline --frozen-lockfile --filter @tulipfarm/worker... \
    && pnpm --filter @tulipfarm/worker... build \
    && pnpm --filter @tulipfarm/worker deploy --legacy --prod /out
FROM build AS local-identity
RUN node packages/build-info/generate.mjs worker /out/worker-version.json --local \
    && node packages/build-info/generate.mjs storage-maintenance /out/storage-version.json --local

FROM build AS release-identity
ARG RELEASE_VERSION
ARG RELEASE_COMMIT
RUN RELEASE_VERSION=$RELEASE_VERSION RELEASE_COMMIT=$RELEASE_COMMIT node packages/build-info/generate.mjs worker /out/worker-version.json \
    && RELEASE_VERSION=$RELEASE_VERSION RELEASE_COMMIT=$RELEASE_COMMIT node packages/build-info/generate.mjs storage-maintenance /out/storage-version.json

FROM node:26-slim AS runtime
RUN apt-get update && apt-get install --no-install-recommends -y git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules node_modules
COPY --from=build --chown=node:node /repo/apps/worker/dist dist
USER node
CMD ["node", "dist/worker.js"]

FROM runtime AS local-storage-maintenance
ENV NODE_ENV=development
COPY --from=local-identity --chown=node:node /out/storage-version.json version.json
CMD ["node", "dist/storage-worker.js"]

FROM runtime AS local-worker
ENV NODE_ENV=development
COPY --from=local-identity --chown=node:node /out/worker-version.json version.json

FROM runtime AS storage-maintenance
ENV NODE_ENV=production
COPY --from=release-identity --chown=node:node /out/storage-version.json version.json
CMD ["node", "dist/storage-worker.js"]

FROM runtime AS worker
ENV NODE_ENV=production
COPY --from=release-identity --chown=node:node /out/worker-version.json version.json
