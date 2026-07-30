# Releases

TulipFarm uses a release PR followed by an automatic, artifact-promoting publication pipeline.
A release is complete only when the verified container image is available in GHCR and the matching
GitHub Release has been published.

## Maintainer workflow

Request an exact stable version from any local checkout:

```bash
pnpm release 0.5.0
```

For a prerelease, provide the complete prerelease version:

```bash
pnpm release:canary 0.5.0-beta.0
```

The command authenticates with `gh` and dispatches the **Prepare release** workflow on `main`.
It does not change the local checkout, create a tag, publish an image, or create a GitHub Release.

The workflow freezes the current `main` commit, opens a ready-for-review PR named
`chore(release): v<version>`, and generates `package.json` and `CHANGELOG.md` for that exact
snapshot. Review both files, wait for the required checks, and merge the PR. That merge is the
maintainer's publication approval. No command, workflow dispatch, or approval is required after
the merge.

Version increments such as `minor` are intentionally rejected. An exact version keeps the proposed
release explicit and reviewable.

Commits merged into `main` while the release PR is awaiting approval are not added to the frozen
release. The release tag records its preparation-time source boundary, so those later commits are
included in the next release instead.

### Workflow input mismatch

If GitHub returns `Unexpected inputs provided: ["version"]`, the local release script is newer than
`.github/workflows/release.yml` on `main`. Merge the release-automation changes first, then rerun
the same release command. Do not fall back to the older direct-tagging workflow.

## Publication pipeline

Merging a same-repository `release/v<version>` PR starts **Publish release**:

```text
release PR merged into main
  -> validate version, non-empty changelog, changed files, and source ancestry
  -> run lint, typecheck, tests, and the workspace build on the reviewed snapshot
  -> build one linux/amd64 + linux/arm64 image as sha-<release-snapshot>
  -> verify both platforms are present
  -> run Compose parity against that exact candidate image
  -> create the annotated v<version> tag with its main source boundary
  -> promote the candidate manifest to v<version>
  -> also promote it to latest for a stable release
  -> create the GitHub Release with the image pull command and changelog section
```

Prereleases follow the same gates, are marked as prereleases on GitHub, and never move `latest`.

Every Conventional Commit type allowed by the repository is visible in the changelog. Features,
fixes, performance changes, reverts, documentation, refactors, tests, build changes, CI changes,
styles, and maintenance each have a section. Generated `chore(release)` commits are the only
bookkeeping entries omitted. An unknown commit type or an empty generated section fails release
preparation rather than silently publishing incomplete notes.

The candidate tag is intentionally retained:

```text
ghcr.io/tulipfarm/tulipfarm:sha-<release-snapshot>
```

It records the immutable reviewed-snapshot-to-image relationship and makes a failed publication
retry reuse the previously built artifact. Promotion uses `docker buildx imagetools`; it assigns
release tags to the verified manifest without rebuilding it.

## Failure and retry behavior

The GitHub Release is the final publication step. If source validation, the quality suite, the
multi-architecture build, or Compose parity fails, no GitHub Release is created and neither the
version tag nor `latest` is moved.

If a later publication step fails, rerun the failed jobs from the **Publish release** workflow.
Tag creation and candidate building are idempotent when they already point to the expected release
snapshot. Never delete and recreate a published version to hide a failure; fix the pipeline or cut
a new patch release when the released artifact itself is defective.

## Repository setup

Configure these controls once:

1. Protect `main` and require the repository's CI gate before merge.
2. In **Settings → Actions → General → Workflow permissions**, grant read/write workflow
   permissions and allow GitHub Actions to create pull requests. Alternatively, configure a
   `RELEASE_TOKEN` secret that can write repository contents, open pull requests, and dispatch
   workflows.
3. Add a tag ruleset for `v*` that restricts creation, updates, and deletion to release automation.
4. Keep the GHCR package linked to this repository and grant Actions write access to it.

When `RELEASE_TOKEN` is absent, **Prepare release** explicitly dispatches CI for the generated
branch. GitHub suppresses ordinary push and pull-request workflow events created by its default
workflow token.

## Implementation map

| File | Responsibility |
| --- | --- |
| `scripts/request-release.ts` | Validates the requested version and dispatches preparation |
| `scripts/release-changelog.ts` | Resolves source boundaries and generates/validates release notes |
| `.github/workflows/release.yml` | Generates the version/changelog commit and opens the release PR |
| `.github/workflows/publish-image.yml` | Validates the merge, builds, verifies, promotes, and releases |
| `.github/workflows/compose-parity.yml` | Verifies either a local CI build or the exact release candidate |
