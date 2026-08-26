#!/usr/bin/env bash
# Install the skill-runtime-probe fixture into a development Soul so the sandbox Skill command
# path (shell, Python, TypeScript) can be exercised by hand.
#
# Usage:
#   scripts/install-skill-runtime-probe.sh              # build the runtime image, then install
#   scripts/install-skill-runtime-probe.sh --skip-build # reuse the image already tagged :local
#   scripts/install-skill-runtime-probe.sh --smoke-only # only run the container smoke test
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${REPO_ROOT}/scripts/dev/skill-runtime-probe/soul"
SOUL_DIR="${SOUL_PATH:-$HOME/.tulipfarm/soul}"
ENV_FILE="${REPO_ROOT}/.env.local"
BASE_IMAGE_TAG="node:26-bookworm-slim"
IMAGE_TAG="ghcr.io/tulipfarm/skill-runtime:local"

skip_build=0
smoke_only=0
for arg in "$@"; do
  case "${arg}" in
    --skip-build) skip_build=1 ;;
    --smoke-only) smoke_only=1; skip_build=1 ;;
    *) echo "unknown option: ${arg}" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

repo_digest() {
  docker inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$1" 2>/dev/null
}

step "Checking Docker"
docker version --format '{{.Server.Version}}' > /dev/null

if [[ "${skip_build}" -eq 0 ]]; then
  step "Pulling the reviewed Node base"
  docker pull --quiet "${BASE_IMAGE_TAG}" > /dev/null
  base_ref="$(repo_digest "${BASE_IMAGE_TAG}")"
  [[ -n "${base_ref}" ]] || { echo "cannot resolve a digest for ${BASE_IMAGE_TAG}" >&2; exit 1; }
  echo "base: ${base_ref}"

  step "Building the Skill runtime image"
  docker build --build-arg "BASE_IMAGE=${base_ref}" --tag "${IMAGE_TAG}" "${REPO_ROOT}/docker/skill-runtime"
fi

runtime_ref="$(repo_digest "${IMAGE_TAG}")"
if [[ -z "${runtime_ref}" ]]; then
  echo "cannot resolve a digest for ${IMAGE_TAG}." >&2
  echo "The sandbox only accepts an immutable repository@sha256:... reference." >&2
  exit 1
fi

step "Smoke-testing every runtime in the container"
smoke_dir="$(mktemp -d)"
trap 'rm -rf "${smoke_dir}"' EXIT
mkdir -p "${smoke_dir}/input/entrypoint" "${smoke_dir}/input/artifacts"
printf '{"message":"smoke test"}' > "${smoke_dir}/input/artifacts/0-input.json"

# Docker Desktop's virtiofs share invalidates a bind-mounted directory once the host deletes a
# file the container created, so each probe gets its own output directory rather than a reused one.
probe_index=0
for entry in "probe.sh bash" "probe.py python3" "probe.ts tsx" "probe-inline.sh bash"; do
  set -- ${entry}
  file="$1"; interpreter="$2"
  probe_index=$((probe_index + 1))
  out_dir="${smoke_dir}/output-${probe_index}"
  mkdir -p "${out_dir}"
  cp "${FIXTURE_DIR}/skills/skill-runtime-probe/scripts/${file}" "${smoke_dir}/input/entrypoint/${file}"
  docker run --rm --read-only --network=none \
    --env TULIP_INPUT_DIR=/tulip/input/artifacts \
    --env TULIP_OUTPUT_DIR=/tulip/output \
    --mount "type=bind,source=${smoke_dir}/input,target=/tulip/input,readonly" \
    --mount "type=bind,source=${out_dir},target=/tulip/output" \
    "${runtime_ref}" "${interpreter}" "/tulip/input/entrypoint/${file}"
  [[ -f "${out_dir}/result.json" ]] || { echo "${file} wrote no result.json" >&2; exit 1; }
  echo "  ${file} -> $(cat "${out_dir}/result.json")"
done

step "Smoke-testing egress: curl and wget through the allowlisting proxy"
pnpm --filter @tulipfarm/sandbox exec tsx \
  "${REPO_ROOT}/scripts/dev/skill-runtime-probe/egress-check.mts" "${runtime_ref}"

if [[ "${smoke_only}" -eq 1 ]]; then
  step "Done (smoke test only)"
  echo "SANDBOX_RUNTIME_IMAGE=${runtime_ref}"
  exit 0
fi

step "Recording SANDBOX_RUNTIME_IMAGE in .env.local"
[[ -f "${ENV_FILE}" ]] || cp "${REPO_ROOT}/.env.local.example" "${ENV_FILE}"
tmp_env="$(mktemp)"
grep -v '^SANDBOX_RUNTIME_IMAGE=' "${ENV_FILE}" > "${tmp_env}"
printf 'SANDBOX_RUNTIME_IMAGE=%s\n' "${runtime_ref}" >> "${tmp_env}"
mv "${tmp_env}" "${ENV_FILE}"
echo "SANDBOX_RUNTIME_IMAGE=${runtime_ref}"

step "Installing the probe artifacts into ${SOUL_DIR}"
if [[ ! -d "${SOUL_DIR}/.git" ]]; then
  echo "no Soul repo at ${SOUL_DIR}. Run scripts/setup-dev.sh first, or set SOUL_PATH." >&2
  exit 1
fi
mkdir -p "${SOUL_DIR}/skills" "${SOUL_DIR}/tools"
rm -rf \
  "${SOUL_DIR}/skills/skill-runtime-probe" \
  "${SOUL_DIR}/tools/skill-runtime-probe-shell" \
  "${SOUL_DIR}/tools/skill-runtime-probe-python" \
  "${SOUL_DIR}/tools/skill-runtime-probe-typescript" \
  "${SOUL_DIR}/tools/skill-runtime-probe-inline" \
  "${SOUL_DIR}/tools/skill-runtime-probe-network"
cp -R "${FIXTURE_DIR}/skills/skill-runtime-probe" "${SOUL_DIR}/skills/"
cp -R "${FIXTURE_DIR}/tools/." "${SOUL_DIR}/tools/"

git -C "${SOUL_DIR}" add --all skills/skill-runtime-probe tools
if git -C "${SOUL_DIR}" diff --cached --quiet; then
  echo "already installed and unchanged"
else
  git -C "${SOUL_DIR}" commit --quiet -m "feat(skills): install skill-runtime-probe dev fixture"
  echo "committed to the Soul repo"
fi

step "Next"
cat <<'EOF'
1. Restart the stack so the API republishes the Soul bundle:  pnpm dev
2. Open http://localhost:4000/skills -> skill-runtime-probe.
   Each command should report the runtime as available.
3. In chat, ask the agent to run a declared command, for example:
   "Run the probe_shell command of the skill-runtime-probe skill and show me the raw result."

To remove it:  scripts/dev/skill-runtime-probe/uninstall.sh
EOF
