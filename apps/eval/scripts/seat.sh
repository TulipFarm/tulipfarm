#!/usr/bin/env sh
#
# Run a Sweep against one or more vendor subscription seats.
#
# The credential is read into this script's own environment and dies with it. It never enters the
# calling shell, never reaches shell history, and is never echoed — which is the only reason a
# personal seat is safe to use from a repo that is public.
#
# Usage: sh scripts/seat.sh <model>[,<model>...] [eval options...]
#
# A comma-separated list runs the matrix. Every seat named is authenticated up front, because a
# credential prompt arriving half way through would land after the first model had already spent
# its quota on a run that cannot now be completed.

set -eu

models=$1
shift

# Restore the terminal even if the read is interrupted, or the shell is left with echo off.
restore_tty() {
  stty echo 2>/dev/null || true
}

prompt_secret() {
  printf '%s\n' "$2" >&2
  printf 'paste it here (hidden), then press enter: ' >&2
  # EXIT covers what INT cannot: under `set -e` a failed read — Ctrl-D, or any non-interactive
  # stdin — kills the script between `stty -echo` and the restore, leaving the operator typing
  # blind into a terminal with echo off.
  trap 'restore_tty' EXIT
  trap 'restore_tty; exit 130' INT
  stty -echo 2>/dev/null || true
  secret=""
  IFS= read -r secret || true
  restore_tty
  trap - INT
  trap - EXIT
  printf '\n' >&2
  if [ -z "$secret" ]; then
    printf 'no %s given — aborting rather than running unauthenticated.\n' "$1" >&2
    exit 1
  fi
}

collect() {
  case "$1" in
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
      printf 'unknown model "%s" — expected: sonnet, luna\n' "$1" >&2
      exit 1
      ;;
  esac
}

# Model names never contain spaces, so turning the separators into spaces is enough to iterate.
for model in $(printf '%s' "$models" | tr ',' ' '); do
  collect "$model"
done

# A seat reports no dollar cost, so only a token ceiling can bound a Sweep. Supply a default rather
# than let the run be refused, but never override a ceiling the caller chose. The ceiling is per
# model, so a matrix run gets each model the same allowance rather than making them share one.
ceiling=""
for arg in "$@"; do
  case "$arg" in
    --max-tokens | --max-tokens=*) ceiling=1 ;;
  esac
done
if [ -z "$ceiling" ]; then
  set -- "$@" --max-tokens 20000
fi

exec tsx src/cli.ts --model "$models" "$@"
