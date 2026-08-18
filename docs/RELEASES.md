# Releases

TulipFarm uses a release PR followed by an automatic, artifact-promoting publication pipeline.
A release is complete only when the verified container image is available in GHCR and the matching
GitHub Release has been published.

## Before requesting a release

Run the offline eval **before** dispatching a release. It is the only gate that measures whether
the agent harness still behaves — CI's unit tests cannot tell a harness regression from a model
having a different day, and the eval exists precisely to separate those two.

Dispatch the **Eval** workflow on `main` from the Actions tab, with `models: sonnet,terra` and
`suites: both`. It is maintainer-only by construction: `workflow_dispatch` is its sole trigger, the
seat credentials live in the `eval` Environment, and that Environment's required reviewer pauses the
job before it spends any quota. Both seats are finite subscription seats, so treat every run as
costing something.

A release is blocked when the Sweep reports `NOT CLEARED`. Read the reason it prints rather than the
pass count:

| Reason | What it means |
| --- | --- |
| a Case failed | A harness regression on that seat. Fix it before releasing. |
| an attack landed on every model | A payload nothing in the repository defends against. |
| a high-severity vulnerability leaked | Never releasable. |
| a guard no model exercised | The guard is unproven, not broken — strengthen the Case or accept it deliberately. |
| a Baseline regression | Only reported when the `baseline` input is checked. |

Two verdicts are **not** blockers and must not be treated as ones. `ERR` is a vendor fault, and a
Case that lands on one seat but not the other is model variance — the second seat exists to make
that distinction, not to rank the models. Both are held out of the comparison on purpose.

Run the same thing locally with `pnpm eval:matrix` and `pnpm eval:redteam:matrix`, which use the
same runner as the workflow. `pnpm eval` runs the whole Corpus on the free scripted tier in about
six seconds and needs no credential; it catches wiring mistakes before a Sweep spends quota, but it
never substitutes for one. See [`apps/eval/README.md`](../apps/eval/README.md).

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
  -> assert the required CI checks already recorded a pass for that exact commit
  -> build one linux/amd64 + linux/arm64 image as sha-<release-snapshot>,
     each platform on a native runner (no QEMU)
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

The GitHub Release is the final publication step. If source validation, the required-check
assertion, the multi-architecture build, or Compose parity fails, no GitHub Release is created
and neither the version tag nor `latest` is moved.

The publication path deliberately does **not** re-run lint, typecheck, tests, and the build. The
release commit is the head of a pull request that branch protection already required to be green,
so `Verify merged source` asserts the recorded conclusions of `CI Success`, `Docker build`,
`Compose parity`, and `Installer smoke` for that SHA instead of recomputing them. Re-running them
added roughly sixteen minutes to every release and put the repository's least reliable command
(root `pnpm test`) on the publication critical path.

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
| `.github/workflows/compose-parity.yml` | Reusable gate that verifies the exact release candidate image |
| `.github/workflows/container.yml` | Pull-request and main container pipeline: builds the image once, then runs Compose parity and the installer smoke against it |
| `.github/workflows/eval.yml` | Maintainer-only pre-release eval Sweep across both model seats |
