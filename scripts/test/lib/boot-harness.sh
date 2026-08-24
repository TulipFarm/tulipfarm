# Platform-independent primitives for a stack boot check.
#
# A boot check proves the bundled stack comes up and answers its health probes. The
# platform-independent core — run in a throwaway workspace so a real installation on the
# same machine is untouched, poll an endpoint until it is ready, capture logs when a step
# fails, and tear the stack down safely afterwards — lives here. Per-platform callers
# (Compose today; Kubernetes, Coolify and Azure Container Apps next) source this file and
# supply only the platform-specific bring-up, teardown and log capture.
#
# The caller owns shell options (`set -euo pipefail`) and drives the checks; this file only
# defines helpers and the cleanup trap.
#
# Contract for a caller:
#   - set BOOT_LABEL before sourcing (defaults to "boot") — tags every log line
#   - override boot_capture_logs and boot_teardown with the platform's commands
#   - call boot_make_workspace, then boot_install_cleanup_trap, before bring-up

BOOT_LABEL="${BOOT_LABEL:-boot}"

log() { printf '\033[0;36m[%s]\033[0m %s\n' "$BOOT_LABEL" "$*"; }
fail() { printf '\033[0;31m[%s] FAIL:\033[0m %s\n' "$BOOT_LABEL" "$*" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not on PATH"
}

# Overridden by the caller. The defaults are inert so a caller that has not brought
# anything up yet — or forgot to set them — tears nothing down rather than guessing.
boot_capture_logs() { :; }
boot_teardown() { :; }

# Creates the throwaway workspace and exports BOOT_WORKDIR. Per-platform config is written
# here, never into a real installation directory.
boot_make_workspace() {
  BOOT_WORKDIR="$(mktemp -d)"
  export BOOT_WORKDIR
}

# On failure, capture logs before anything is destroyed; then always tear down and remove
# the workspace. Install this only after BOOT_WORKDIR exists so an early failure still
# cleans up.
boot_install_cleanup_trap() {
  trap _boot_cleanup EXIT
}

_boot_cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    boot_capture_logs || true
  fi
  boot_teardown || true
  [ -n "${BOOT_WORKDIR:-}" ] && rm -rf "$BOOT_WORKDIR"
  return "$status"
}

# Poll an HTTP endpoint until it answers 2xx or the retry budget is spent. Every platform
# exposes the same probes over HTTP, so readiness polling needs nothing platform-specific.
boot_wait_for_http() {
  curl -fsS --max-time 15 --retry 5 --retry-connrefused --retry-delay 3 "$1" >/dev/null
}

# A single-shot probe with no retry, for an endpoint the stack should already be serving
# once boot_wait_for_http has passed.
boot_check_http() {
  curl -fsS --max-time 15 "$1" >/dev/null
}
