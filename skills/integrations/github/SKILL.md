---
name: github
description: Triage GitHub issues, work pull requests, and read repository content.
eager: true
category: integrations
---
# GitHub

Use this Skill when the user wants to read or act on a connected GitHub repository: issues, pull
requests, check runs, or file/directory content. It is only shown while a GitHub App installation is
active for this business — if it is not, treat GitHub work as unavailable and say so rather than
guessing at API access.

## Tools

- `github_repository_list` — no arguments; lists every repository this business has GitHub
  installed for. Every other tool below requires a `repository` argument (`owner/repo`) that must
  exactly match an installed repo, or the call fails — call this first whenever the user names no
  repository, or names one you haven't confirmed is installed.
- `github_issue_read`, `github_issue_search` — read one issue or search issues by query and state.
  `query` is optional — omit it (or pass `""`) to list every issue matching only `state`, instead
  of filtering by text. To search more than one repository, pass `repositories` (up to 25) instead
  of `repository` — this runs as a single call, not one per repository. Omit both `repository` and
  `repositories` to search every repository this business has installed; do this instead of
  calling the search tool once per repository from `github_repository_list`.
- `github_issue_comment`, `github_issue_label`, `github_issue_assign`, `github_issue_close` —
  mutating; each parks on approval under `approval-required` autonomy like any other write.
- `github_pull_request_read`, `github_pull_request_search` — read one PR or search by query and
  state. `query` is optional here too — omit it to list every PR matching only `state`. Same
  `repositories` / "search everything installed" behavior as `github_issue_search`.
- `github_pull_request_create`, `github_pull_request_comment`, `github_pull_request_review`,
  `github_pull_request_merge` — mutating.
- `github_check_run_read` — read one check run's status and conclusion.
- `github_content_read`, `github_content_list` — read a file's contents, or list a directory (or
  repository root).
- `github_repo_push` — commit one or more files to a branch; mutating.

## Workflow

1. Identify the repository (`owner/repo`) and, for issues/PRs, the number. If the user names no
   repository, or you're not sure it's installed, call `github_repository_list` rather than
   guessing — any other tool call against an uninstalled or misspelled repository fails outright.
   Ask the user only when `github_repository_list` returns more than one plausible match. Exception:
   for an issue/PR search across repositories (e.g. "show me all my open issues"), skip
   `github_repository_list` and go straight to a search call with `repository`/`repositories`
   omitted — the search tools resolve "every installed repository" themselves.
2. Prefer a search tool over guessing a number when the user describes an issue or PR rather than
   naming it directly (e.g. "the flaky-test issue").
3. Read before you act: fetch the current issue/PR state before commenting, labeling, reviewing, or
   merging, so the action reflects what is actually there.
4. For mutating calls, state plainly what will happen (e.g. "merging PR #42 into main") before
   calling the tool — the approval-wait UI shows the call, but the chat reply should not require the
   user to decode raw tool arguments to know what they're approving.
5. After a mutating call succeeds, confirm with the concrete result (e.g. the comment posted, the
   merge SHA) rather than a generic "done."

## Safety

- Never merge a pull request the user has not asked to merge, even if checks are passing.
- Never close an issue or PR speculatively — only when the user's intent to close is explicit.
- A replayed mutating call (rare: only after a crash mid-call) returns `{ replayed: true }` with no
  original response body — say the action already completed; do not repeat it or claim to know
  details you don't have.

## Presentation

Use a structured surface for issue/PR lists or detail views. Keep the text summary to one sentence
naming the repository and number. If you fall back to plain Markdown (surface unavailable or
correction limit reached), still name each issue/PR as a Markdown link to its `htmlUrl` (e.g.
`[#169](https://github.com/tulip/farm/issues/169)`), never a bare number. Never use emojis, in
either a surface or plain-text reply.
