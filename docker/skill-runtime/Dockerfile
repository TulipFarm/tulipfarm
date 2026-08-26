# syntax=docker/dockerfile:1.7

# Supply an immutable Node base, for example:
#   --build-arg BASE_IMAGE=node:26-bookworm-slim@sha256:<reviewed digest>
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Package installation belongs to image review/build, never to a Skill Run. The published image is
# referenced by its resulting OCI digest in SANDBOX_RUNTIME_IMAGE.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends bash ca-certificates curl jq python3 wget \
  && rm -rf /var/lib/apt/lists/* \
  && printf '%s\n' '#!/bin/sh' 'exec node "$@"' > /usr/local/bin/tsx \
  && chmod 0755 /usr/local/bin/tsx

WORKDIR /tulip

# The development executor supplies the host user's uid/gid and a read-only root filesystem. This
# fallback keeps an accidentally interactive container non-root too.
USER 65534:65534

CMD ["bash", "-lc", "exit 64"]
