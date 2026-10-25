#!/usr/bin/env bash
# Commits the working tree to $BRANCH as tulipfarm-dot, force-pushes it, and opens
# or updates its pull request against $BASE: a draft unless $PASSED is true.
# Prints the pull request URL.
# Env: GH_TOKEN BRANCH BASE TITLE BODY_FILE PASSED GITHUB_REPOSITORY
set -euo pipefail

# Copilot must not change workflows, CI or this automation.
protected=(.github)
git restore --source=HEAD --staged --worktree -- "${protected[@]}"
git clean -fdq -- "${protected[@]}"

git config user.name tulipfarm-dot
git config user.email 291055112+tulipfarm-dot@users.noreply.github.com
git switch -q -C "$BRANCH"
git add -A
git commit -qm "$TITLE"
git push -q --force "https://x-access-token:$GH_TOKEN@github.com/$GITHUB_REPOSITORY.git" "HEAD:refs/heads/$BRANCH"

if [ "$(gh pr view "$BRANCH" --json state --jq .state 2>/dev/null)" = OPEN ]; then
  gh pr edit "$BRANCH" --base "$BASE" --title "$TITLE" --body-file "$BODY_FILE" >&2
  if [ "$PASSED" = true ]; then
    gh pr ready "$BRANCH" >&2 || true
  else
    gh pr ready --undo "$BRANCH" >&2 || true
  fi
  gh pr view "$BRANCH" --json url --jq .url
else
  draft=()
  [ "$PASSED" = true ] || draft=(--draft)
  gh pr create --base "$BASE" --head "$BRANCH" --title "$TITLE" --body-file "$BODY_FILE" "${draft[@]}"
fi
