# Skill runtime image

Development runtime for published Skill commands. It contains Bash, Node, a `tsx` compatibility
launcher backed by Node's native TypeScript type stripping, Python 3, `curl`, and `jq`. Google
Workspace `gws` is intentionally not included.

Build from a reviewed, digest-pinned Node base and record the resulting digest:

```bash
docker build \
  --build-arg BASE_IMAGE=node:26-bookworm-slim@sha256:<reviewed-base-digest> \
  --tag ghcr.io/tulipfarm/skill-runtime:local \
  docker/skill-runtime

docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/tulipfarm/skill-runtime:local
```

Set `SANDBOX_RUNTIME_IMAGE` to the exact `repository@sha256:...` result for local development.
The Worker ignores this Docker backend in production; production requires an attested remote or
microVM backend implementing the signed sandbox protocol.
