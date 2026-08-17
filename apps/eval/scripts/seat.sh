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

# Accept a pasted Codex credential.
#
# Two things go wrong with a paste that the vendor cannot tell you about — it answers both with a
# bare 401 that says nothing about the input. First, a credential is usually copied inside quotes
# and arrives carrying them. Second, `read` keeps only the first line, so a pretty-printed
# auth.json arrives as a lone "{". Both are caught here instead.
#
# Sets CODEX_AUTH_JSON directly: inside `$(...)` an `exit` would only leave the subshell, and the
# script would carry on with an empty credential.
accept_codex_json() {
  value=$1
  case "$value" in
    \'*\')
      value=${value#\'}
      value=${value%\'}
      ;;
    \"*\")
      value=${value#\"}
      value=${value%\"}
      ;;
  esac
  case "$value" in
    \{*\})
      CODEX_AUTH_JSON=$value
      ;;
    \{*)
      printf 'that credential is truncated: a multi-line paste keeps only its first line.\n' >&2
      printf 'Paste the whole of auth.json as one line — jq -c . ~/.codex/auth.json prints it.\n' >&2
      exit 1
      ;;
    *)
      printf 'that is not a JSON object: paste the contents of auth.json, which starts with {.\n' >&2
      exit 1
      ;;
  esac
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
      if [ -z "${CODEX_AUTH_JSON:-}" ]; then
        auth="${CODEX_HOME:-$HOME/.codex}/auth.json"
        if [ -r "$auth" ]; then
          CODEX_AUTH_JSON=$(cat "$auth")
        else
          prompt_secret CODEX_AUTH_JSON "Codex seat credential: the contents of auth.json, on one line. Get one with: codex login"
          accept_codex_json "$secret"
        fi
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
