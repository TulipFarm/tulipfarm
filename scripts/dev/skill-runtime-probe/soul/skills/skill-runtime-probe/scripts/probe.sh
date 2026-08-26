#!/usr/bin/env bash
# Sandbox contract: arguments arrive as an Artifact, the result must be written to
# $TULIP_OUTPUT_DIR/result.json, and the container has no network.
set -euo pipefail

arguments="${TULIP_INPUT_DIR}/0-input.json"
message="$(jq -r '.message // "no message"' "${arguments}")"

echo "probe.sh received: ${message}" >&2

jq -n \
  --arg interpreter "$(bash --version | head -n 1)" \
  --arg echoed "${message}" \
  '{ok: true, runtime: "shell", interpreter: $interpreter, echoed: $echoed}' \
  > "${TULIP_OUTPUT_DIR}/result.json"
