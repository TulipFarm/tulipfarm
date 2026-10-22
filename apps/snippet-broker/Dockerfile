FROM node:26-slim AS build
RUN npm install --global pnpm@11.5.3
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
RUN pnpm fetch
COPY . .
# Filtered installs may not include every patched package; the full install stays strict.
RUN printf '\nallowUnusedPatches: true\n' >> pnpm-workspace.yaml
RUN pnpm install --offline --frozen-lockfile --filter @tulipfarm/snippet-broker... \
    && pnpm --filter @tulipfarm/snippet-broker... build \
    && pnpm --filter @tulipfarm/snippet-broker deploy --legacy --prod /out
FROM build AS local-identity
RUN node packages/build-info/generate.mjs snippet-broker /out/version.json --local

FROM build AS release-identity
ARG RELEASE_VERSION
ARG RELEASE_COMMIT
RUN RELEASE_VERSION=$RELEASE_VERSION RELEASE_COMMIT=$RELEASE_COMMIT node packages/build-info/generate.mjs snippet-broker /out/version.json

FROM node:26-slim AS runtime
RUN apt-get update && apt-get install --no-install-recommends -y docker-cli ca-certificates && rm -rf /var/lib/apt/lists/*
ENV HOST=0.0.0.0 PORT=8090
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules node_modules
COPY --from=build /repo/apps/snippet-broker/dist dist
CMD ["node", "dist/server.js"]

FROM runtime AS local
ENV NODE_ENV=development
COPY --from=local-identity /out/version.json ./

FROM runtime AS production
ENV NODE_ENV=production
COPY --from=release-identity /out/version.json ./
