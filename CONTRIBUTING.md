# Contributing

Thanks for helping improve TulipFarm. Bug fixes, tests, and documentation fixes
are welcome.

## Before you start

- For small fixes, open a pull request directly.
- For new features or larger changes, open an issue first so we can agree on the
  approach.
- Report security issues privately; see [SECURITY.md](SECURITY.md).

## Contributor License Agreement

Contributions require a signed Contributor License Agreement (CLA). CLA Assistant
asks you to sign it on your first pull request. We cannot merge a pull request
until the CLA is signed.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Set up the repository as described in [DEVELOPMENT.md](DEVELOPMENT.md).
3. Keep each pull request focused on one change. Commit dependency changes with
   `pnpm-lock.yaml`.
4. Run the checks:

   ```sh
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

5. Open a pull request that explains what changed and why. Add screenshots for
   visual changes.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), for
example `fix(api): reject expired invitations` or `docs: clarify setup`.

## License

By contributing, you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE) and the terms of the CLA.
