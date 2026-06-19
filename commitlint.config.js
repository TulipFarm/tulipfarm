/**
 * Conventional Commits enforcement for local commits — mirrors the PR-title
 * check in .github/workflows/pr-title.yml and feeds clean history to
 * release-it's @release-it/conventional-changelog (version bump + CHANGELOG).
 *
 * Run via the lefthook `commit-msg` hook (see lefthook.yml). config-conventional's
 * default type-enum is exactly the set the PR-title workflow allows:
 *   build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test.
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
};
