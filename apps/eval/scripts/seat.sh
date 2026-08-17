#!/usr/bin/env sh
#
# Run a Sweep against a vendor subscription seat.
#
# The credential is read into this script's own environment and dies with it. It never enters the
# calling shell, never reaches shell history, and is never echoed — which is the only reason a
# personal seat is safe to use from a repo that is public.
#
# Usage: sh scripts/seat.sh <model> [eval options...]

set -eu

model=$1
shift

# Restore the terminal even if the read is interrupted, or the shell is left with echo off.
restore_tty() {
  stty echo 2>/dev/null || true
}

prompt_secret() {
  printf '%s\n' "$2" >&2
  printf 'paste it here (hidden), then press enter: ' >&2
  trap 'restore_tty; exit 130' INT
  stty -echo 2>/dev/null || true
  IFS= read -r secret
  restore_tty
  trap - INT
  printf '\n' >&2
  if [ -z "$secret" ]; then
    printf 'no %s given — aborting rather than running unauthenticated.\n' "$1" >&2
    exit 1
  fi
}

case "$model" in
  sonnet)
    if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      prompt_secret CLAUDE_CODE_OAUTH_TOKEN "Claude Code seat token. Get one with: claude setup-token"
      CLAUDE_CODE_OAUTH_TOKEN=$secret
    fi
    export CLAUDE_CODE_OAUTH_TOKEN
    ;;
  luna)
    # Codex's credential is a JSON document, not something anyone types. Read the file the CLI
    # already wrote, and only fall back to a paste when it is missing.
    if [ -z "${CODEX_AUTH_JSON:-}" ] && [ -r "$HOME/.codex/auth.json" ]; then
      CODEX_AUTH_JSON=$(cat "$HOME/.codex/auth.json")
    fi
    if [ -z "${CODEX_AUTH_JSON:-}" ]; then
      prompt_secret CODEX_AUTH_JSON "Codex seat credential. Run: codex login (writes ~/.codex/auth.json)"
      CODEX_AUTH_JSON=$secret
    fi
    export CODEX_AUTH_JSON
    ;;
  *)
    printf 'unknown model "%s" — expected: sonnet, luna\n' "$model" >&2
    exit 1
    ;;
esac

# A seat reports no dollar cost, so only a token ceiling can bound a Sweep. Supply a default rather
# than let the run be refused, but never override a ceiling the caller chose.
ceiling=""
for arg in "$@"; do
  case "$arg" in
    --max-tokens | --max-tokens=*) ceiling=1 ;;
  esac
done
if [ -z "$ceiling" ]; then
  set -- "$@" --max-tokens 20000
fi

exec tsx src/cli.ts --model "$model" "$@"
