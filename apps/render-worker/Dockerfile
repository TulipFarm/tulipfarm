FROM node:26-slim AS build
RUN npm install --global pnpm@11.5.3
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
# Filtered installs may not include every patched package; the full install stays strict.
RUN printf '\nallowUnusedPatches: true\n' >> pnpm-workspace.yaml
RUN pnpm fetch
COPY packages/ packages/
COPY apps/render-worker/ apps/render-worker/
# Legacy deploy checks the whole lockfile, where sprout is a URL tarball pinned by integrity.
RUN pnpm install --offline --frozen-lockfile --filter @tulipfarm/render-worker... \
    && pnpm --filter @tulipfarm/render-worker... build \
    && pnpm --filter @tulipfarm/render-worker deploy --legacy --prod --config.block-exotic-subdeps=false /out

# Debian's Chromium and Noto fonts. Pages load nothing from the network, so every glyph comes from these fonts.
FROM node:26-slim AS render-worker
RUN apt-get update \
    && apt-get install --no-install-recommends -y chromium fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules node_modules
COPY --from=build --chown=node:node /repo/apps/render-worker/dist dist
USER node
CMD ["node", "dist/worker.js"]
