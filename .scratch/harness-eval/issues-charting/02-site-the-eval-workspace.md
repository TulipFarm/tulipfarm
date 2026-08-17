# Site the eval workspace and its import surface

Type: grilling
Status: open
Blocked by: —

## Question

Where does the eval framework's code live, and what is it allowed to import?

This is load-bearing and hard to reverse: it decides what the runner can reach, and every later
ticket builds inside whatever this decides.

The eval needs an unusually **wide** import surface — `agent-runtime` (to drive `AgentLoop`),
`llm` (to build a real model), `soul` (to load the fixture), `testkit` (fakes), `storage` and
`schema`, and for the L3 tier something close to what `apps/worker` composes. That is wider than
any existing `packages/*` is allowed. `docs/architecture/dependency-rules.md` is binding and must
be read before deciding — this ticket may have to *change* that document, which is itself a
decision worth making deliberately rather than by accident.

Candidate shapes:

- **`apps/eval`** — an app, not a package. Apps already sit at the top of the dependency graph and
  compose freely, so a wide import surface is legal without editing the rules. Ships the CLI.
- **`packages/evals`** — a package. Cleaner name, but likely needs a dependency-rule exemption,
  and packages are meant to be importable by apps, which this never will be.
- **Root `eval/` directory, outside the workspace graph** — like the existing root `test/`. No
  dependency rules apply at all, but it also gets no Turbo caching, no `pnpm --filter`, and falls
  outside `pnpm lint`/`typecheck` fan-out unless wired in.

Also settle in the same session:

- Does it get its own `AGENTS.md`? (Root `AGENTS.md` says a new app or package must, plus a row in
  the navigation table.)
- Is the CLI a `bin` in that workspace, surfaced as a root `pnpm eval` script?
- Does eval code ship in the published Docker image, or is it excluded like tests?
- Does it participate in `pnpm lint` / `pnpm typecheck` / `pnpm test`? Its tests must **not** be
  swept into `pnpm test`, because they cost real money.

Consult `docs/architecture/dependency-rules.md`, `docs/architecture/boundaries.md`,
`turbo.json`, `pnpm-workspace.yaml`, and the `Dockerfile`.
