#!/usr/bin/env bash
# Remove the skill-runtime-probe fixture from a development Soul.
set -euo pipefail

SOUL_DIR="${SOUL_PATH:-$HOME/.tulipfarm/soul}"
[[ -d "${SOUL_DIR}/.git" ]] || { echo "no Soul repo at ${SOUL_DIR}" >&2; exit 1; }

rm -rf \
  "${SOUL_DIR}/skills/skill-runtime-probe" \
  "${SOUL_DIR}/tools/skill-runtime-probe-shell" \
  "${SOUL_DIR}/tools/skill-runtime-probe-python" \
  "${SOUL_DIR}/tools/skill-runtime-probe-typescript" \
  "${SOUL_DIR}/tools/skill-runtime-probe-inline" \
  "${SOUL_DIR}/tools/skill-runtime-probe-network" \

git -C "${SOUL_DIR}" add --all skills tools
if git -C "${SOUL_DIR}" diff --cached --quiet; then
  echo "nothing to remove"
else
  git -C "${SOUL_DIR}" commit --quiet -m "chore(skills): remove skill-runtime-probe dev fixture"
  echo "removed from ${SOUL_DIR}"
fi
