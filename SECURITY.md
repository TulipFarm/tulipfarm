# Security Policy

## Supported versions

TulipFarm is a research preview, released as a single rolling line — only the latest
release receives security fixes. There is no long-term-support branch. Always run the
`latest` tag or the newest tagged version.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/TulipFarm/tulipfarm/security) of this
   repository.
2. Click **Report a vulnerability**.
3. Include what you found, the affected version/commit, steps to reproduce, and the
   potential impact.

This opens a private advisory visible only to you and the maintainers, so we can discuss
and fix the issue before it's public.

## What to expect

- We'll acknowledge your report and confirm we can reproduce it.
- We'll work with you on a fix and, where relevant, a disclosure timeline.
- Once a patched release is out, we'll publish a GitHub Security Advisory crediting you
  (unless you'd rather stay anonymous).

## Scope

In scope: the TulipFarm application (`apps/*`, `packages/*`), the installer scripts, and
the published Docker images. Out of scope: third-party services you connect via
Integrations, and vulnerabilities in dependencies that don't affect TulipFarm's use of
them (report those upstream instead).
