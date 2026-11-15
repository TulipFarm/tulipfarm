FROM node:26-slim AS build
RUN npm install --global pnpm@11.5.3
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
# Filtered installs may not include every patched package; the full install stays strict.
RUN printf '\nallowUnusedPatches: true\n' >> pnpm-workspace.yaml
RUN pnpm fetch
COPY packages/ packages/
COPY apps/gateway/ apps/gateway/
# Legacy deploy checks the whole lockfile, where xlsx is a URL tarball pinned by integrity.
RUN pnpm install --offline --frozen-lockfile --filter @tulipfarm/gateway... \
    && pnpm --filter @tulipfarm/gateway... build \
    && pnpm --filter @tulipfarm/gateway deploy --legacy --prod --config.block-exotic-subdeps=false /out
FROM build AS local-identity
RUN node packages/build-info/generate.mjs gateway /out/version.json --local

FROM build AS release-identity
ARG RELEASE_VERSION
ARG RELEASE_COMMIT
RUN RELEASE_VERSION=$RELEASE_VERSION RELEASE_COMMIT=$RELEASE_COMMIT node packages/build-info/generate.mjs gateway /out/version.json

FROM node:26-slim AS runtime
ENV HOST=0.0.0.0 PORT=3002
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules node_modules
COPY --from=build --chown=node:node /repo/apps/gateway/dist dist
USER node
EXPOSE 3002
CMD ["node", "dist/server.js"]

FROM runtime AS local
ENV NODE_ENV=development
COPY --from=local-identity --chown=node:node /out/version.json ./

FROM runtime AS production
ENV NODE_ENV=production
COPY --from=release-identity --chown=node:node /out/version.json ./
