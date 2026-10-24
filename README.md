# TulipFarm

TulipFarm lets people describe business operations in chat. Agents build and use
business records, knowledge, skills, and automations within explicit permissions.

> **Research preview.** TulipFarm is early and changes quickly, so expect rough
> edges and breaking changes. Try the hosted version at
> [tulipfarm.ai](https://tulipfarm.ai), and if the project is useful to you,
> star this repository so others can find it.

This repository is the open-source TulipFarm monorepo: the web app, API, Temporal
worker, and shared packages. It uses pnpm workspaces, Turborepo, Oxlint, and
TypeScript.

## Quick start

```sh
pnpm install
pnpm lint
pnpm dev
```

`pnpm dev` starts PostgreSQL, Temporal, and S3-compatible object storage with
Docker Compose, then runs the apps. See [DEVELOPMENT.md](DEVELOPMENT.md) for
prerequisites and commands.

## Documentation

Features, concepts, how-to guides, and self-hosting live at
[docs.tulipfarm.ai](https://docs.tulipfarm.ai).

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md): how to propose changes.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.
- [CHANGELOG.md](CHANGELOG.md): notable changes.

## License

TulipFarm is licensed under the [GNU Affero General Public License v3.0](LICENSE)
(`AGPL-3.0-only`).
