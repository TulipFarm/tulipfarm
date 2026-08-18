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

# Restore the terminal even if the read is interrupted, or the shell is left mid-prompt.
tty_state=""
restore_tty() {
  if [ -n "$tty_state" ]; then
    stty "$tty_state" 2>/dev/null || true
  fi
  stty echo 2>/dev/null || true
}

prompt_secret() {
  printf '%s\n' "$2" >&2
  printf 'paste it here (hidden), then press enter: ' >&2
  tty_state=$(stty -g 2>/dev/null || true)
  # EXIT covers what INT cannot: under `set -e` a failed read — any non-interactive stdin — kills
  # the script between the stty calls and the restore, leaving the operator typing blind into a
  # terminal whose line discipline is still switched off. Abort with Ctrl-C: with the line editor
  # off the kernel no longer treats Ctrl-D as end-of-file, though ISIG stays on so Ctrl-C works.
  trap 'restore_tty' EXIT
  trap 'restore_tty; exit 130' INT
  stty -echo 2>/dev/null || true
  # Canonical mode discards any line past MAX_CANON — 1024 bytes on macOS — and never delivers the
  # newline, so a multi-kilobyte credential does not arrive truncated: the prompt simply hangs. A
  # Codex auth.json is several KB of JWTs, so the line editor has to be off for the paste to land.
  stty -icanon min 1 time 0 2>/dev/null || true
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
      printf 'Point CODEX_AUTH_FILE at the file instead:\n' >&2
      printf '  CODEX_AUTH_FILE=/path/to/auth.json pnpm eval:matrix\n' >&2
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
      # A file is the only route that cannot be defeated by the terminal: see prompt_secret.
      if [ -z "${CODEX_AUTH_JSON:-}" ] && [ -n "${CODEX_AUTH_FILE:-}" ]; then
        if [ ! -r "$CODEX_AUTH_FILE" ]; then
          printf 'CODEX_AUTH_FILE is not readable: %s\n' "$CODEX_AUTH_FILE" >&2
          exit 1
        fi
        CODEX_AUTH_JSON=$(cat "$CODEX_AUTH_FILE")
      fi
      if [ -z "${CODEX_AUTH_JSON:-}" ]; then
        auth="${CODEX_HOME:-$HOME/.codex}/auth.json"
        if [ -r "$auth" ]; then
          CODEX_AUTH_JSON=$(cat "$auth")
        else
          prompt_secret CODEX_AUTH_JSON "Codex seat credential: the contents of auth.json, on one line.
If the paste does not land, save it to a file and use: CODEX_AUTH_FILE=/path/to/auth.json"
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
#
# Expressed per Trial, not as a Sweep total. A fixed total is sized for the Corpus of the day it
# was written: the 20000 that comfortably held two Cases truncated the Sweep at five of nine once
# the guardrail Cases landed, and a truncated Sweep is reported as NOT COMPARABLE rather than as a
# result. 15000 is roughly triple the heaviest per-Trial cost observed on either seat.
ceiling=""
for arg in "$@"; do
  case "$arg" in
    --max-tokens | --max-tokens=* | --max-tokens-per-trial | --max-tokens-per-trial=*) ceiling=1 ;;
  esac
done
if [ -z "$ceiling" ]; then
  set -- "$@" --max-tokens-per-trial 15000
fi

# Every seat Sweep keeps its Scorecard. A Matrix prints each leg in turn, so a failing early leg
# scrolls away behind the ones after it — and without an artifact the only way to read it back is
# to sweep again, which spends quota a subscription seat has a finite amount of. Same rule as the
# ceiling above: supply a default, never override a directory the caller chose.
# Split by suite, for the same reason the Baselines are: a Scorecard is named for its model, so
# a red-team Sweep and a capability Sweep sharing one directory would have the second silently
# overwrite the first. This mirrors the `--save-dir scorecards/$suite` the CI workflow passes.
saving=""
suite=capability
for arg in "$@"; do
  case "$arg" in
    --save-dir | --save-dir=* | --save | --save=*) saving=1 ;;
    */red-team | */red-team/) suite=red-team ;;
  esac
done
if [ -z "$saving" ]; then
  set -- "$@" --save-dir "scorecards/$suite"
fi

exec tsx src/cli.ts --model "$models" "$@"
