FROM node:26-slim AS build
RUN npm install --global pnpm@11.5.3
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
# Filtered installs may not include every patched package; the full install stays strict.
RUN printf '\nallowUnusedPatches: true\n' >> pnpm-workspace.yaml
RUN pnpm fetch
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN pnpm install --offline --frozen-lockfile --filter @tulipfarm/api... \
    && pnpm --filter @tulipfarm/api... build \
    && pnpm --filter @tulipfarm/api deploy --legacy --prod /out
FROM build AS local-identity
RUN node packages/build-info/generate.mjs api /out/version.json --local

FROM build AS release-identity
ARG RELEASE_VERSION
ARG RELEASE_COMMIT
RUN RELEASE_VERSION=$RELEASE_VERSION RELEASE_COMMIT=$RELEASE_COMMIT node packages/build-info/generate.mjs api /out/version.json

FROM node:26-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists
ENV HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist dist
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]

FROM runtime AS local
ENV NODE_ENV=development
COPY --from=local-identity --chown=node:node /out/version.json ./

FROM runtime AS production
ENV NODE_ENV=production
COPY --from=release-identity --chown=node:node /out/version.json ./
