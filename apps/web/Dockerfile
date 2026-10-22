# Static web app behind Caddy for the self-hosted Compose stack. Caddy serves the
# app and proxies the API on the same origin.
FROM node:26-slim AS build
RUN npm install --global pnpm@11.5.3
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
# Filtered installs may not include every patched package; the full install stays strict.
RUN printf '\nallowUnusedPatches: true\n' >> pnpm-workspace.yaml
RUN pnpm fetch
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm install --offline --frozen-lockfile --filter @tulipfarm/web...
# Unset VITE_API_URL calls the API on the page's own origin, which is how Caddy serves it.
ARG VITE_API_URL=
ARG VITE_SUPPORT_EMAIL=
ARG VITE_AGENT_AVATAR_URL=
ARG VITE_TULIPFARM_WEB_EXTENSIONS=
# Self-host Compose passes the release identity; without it the image reports a development build.
ARG RELEASE_VERSION=
ARG RELEASE_COMMIT=
RUN if [ -n "$RELEASE_VERSION" ]; then \
      RELEASE_VERSION=$RELEASE_VERSION RELEASE_COMMIT=$RELEASE_COMMIT node packages/build-info/generate.mjs web apps/web/version.json; \
    fi \
 && if [ -n "$RELEASE_VERSION" ]; then export TULIPFARM_RELEASE_BUILD=1; fi \
 && pnpm --filter '@tulipfarm/web...' build

FROM caddy:2.10-alpine
COPY --from=build /repo/apps/web/dist /srv
COPY self-host/Caddyfile /etc/caddy/Caddyfile
