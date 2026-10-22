# TulipFarm agent guide

TulipFarm lets people describe business operations in chat. Agents build and use
business records, knowledge, skills, and automations within explicit permissions.

## Repository

Use pnpm; commit dependency changes with `pnpm-lock.yaml`. `apps/web` owns React,
`apps/api` HTTP composition, `apps/worker` Temporal execution, and `packages/` shared
domains. Find matching filenames before reading content. Add scripts only for
actual workspace work. Setup and commands are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Conventions

- Use shared sprout (`@tulipfarm/sprout/<name>`) controls and semantic variants; put layout on
  surrounding HTML, not styling props on components. Use the shared `Select` for
  dropdowns. Oxlint enforces these rules.
- Define loading, empty, success, and error behavior for UI changes.
- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
- Keep secrets in configuration, never in source or docs.

## Domain terms

- A table defines a shape; a row is one instance.
- An agent has bounded authority; a skill supplies a procedure, not authority.
- Workspace, team, project, and access area are distinct.
- Knowledge, personal memory, project context, and chat history are distinct stores.
- Integration access, source-data permission, and action approval are separate checks.
- Saved, active, completed, and visible are different facts.

## Verification

Use focused tests while editing, then run:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

For docs, check links, terminology, and the diff; do not start apps.
