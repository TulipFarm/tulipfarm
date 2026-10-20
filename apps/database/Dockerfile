# Runs pnpm self-host:setup inside the self-hosted Compose stack.
FROM node:26-slim
RUN npm install --global pnpm@11.5.3
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ patches/
# Filtered installs may not include every patched package; the full install stays strict.
RUN printf '\nallowUnusedPatches: true\n' >> pnpm-workspace.yaml
RUN pnpm fetch
COPY packages/ packages/
COPY apps/database/ apps/database/
RUN pnpm install --offline --frozen-lockfile --filter @tulipfarm/database... \
    && pnpm --filter '@tulipfarm/database^...' build \
    && mkdir /setup && chown node:node /setup
USER node
ENTRYPOINT ["node", "apps/database/src/self-host-setup.ts"]
CMD ["--out", "/setup"]
