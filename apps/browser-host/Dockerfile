FROM node:26-slim AS build
RUN npm install --global pnpm@11.5.3
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
# Filtered installs may not include every patched package; the full install stays strict.
RUN printf '\nallowUnusedPatches: true\n' >> pnpm-workspace.yaml
RUN pnpm fetch
COPY packages/ packages/
COPY apps/browser-host/ apps/browser-host/
# Legacy deploy checks the whole lockfile, where xlsx is a URL tarball pinned by integrity.
RUN pnpm install --offline --frozen-lockfile --filter @tulipfarm/browser-host... \
    && pnpm --filter @tulipfarm/browser-host... build \
    && pnpm --filter @tulipfarm/browser-host deploy --legacy --prod --config.block-exotic-subdeps=false /out

# Debian's Chromium with fonts for most scripts, so sites render the way people expect.
# Run this image on a network that cannot reach internal services: the host also refuses private addresses,
# but a network boundary is the real guard.
FROM node:26-slim AS browser-host
RUN apt-get update \
    && apt-get install --no-install-recommends -y chromium fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-liberation ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium BROWSER_HOST_PORT=3010
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules node_modules
COPY --from=build --chown=node:node /repo/apps/browser-host/dist dist
USER node
EXPOSE 3010
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
