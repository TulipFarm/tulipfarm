# Skill runtime probe (development fixture)

A throwaway Skill that proves the sandbox Skill-command path works, in each language the
`shell-ts-python-v1` runtime profile supports. It is **not** a shipped Skill: nothing here lives in
the repo-root `skills/` catalogue, so it reaches a Soul only when you install it deliberately.

## Install

```bash
scripts/install-skill-runtime-probe.sh
```

That script builds `docker/skill-runtime`, records the resulting `repository@sha256:...` in
`SANDBOX_RUNTIME_IMAGE` in `.env.local`, smoke-tests all five entrypoints in the container, egress included, then
copies the artifacts below into `${SOUL_PATH:-$HOME/.tulipfarm/soul}` and commits them.

Then restart `pnpm dev` so the API republishes the Soul bundle.

- `--skip-build` reuses the image already tagged `ghcr.io/tulipfarm/skill-runtime:local`.
- `--smoke-only` runs the container check and touches nothing else.
- `uninstall.sh` removes the artifacts again.

## What it installs

| Soul path | Purpose |
| --- | --- |
| `skills/skill-runtime-probe/SKILL.md` | Model-facing instructions, the `allowedDomains` that gate `web_fetch` / `api_request`, the `allowedCommands` that gate `skill` in `shell` mode, and the fenced blocks it runs. |
| `skills/skill-runtime-probe/skill.yaml` | Five commands: `probe_shell`, `probe_python`, `probe_typescript`, `probe_inline`, `probe_network`. |
| `skills/skill-runtime-probe/scripts/probe.{sh,py,ts}` | One entrypoint per language. |
| `skills/skill-runtime-probe/scripts/probe-inline.sh` | Runs `node -e`, `node <<'JS'`, `python3 -c` and `python3 <<'PY'`. |
| `skills/skill-runtime-probe/scripts/probe-network.sh` | Fetches a declared host with `curl` and `wget`. |
| `tools/skill-runtime-probe-{shell,python,typescript,inline,network}/tool.yaml` | One `adapter.kind: sandbox` ToolContract per command. |

## Verify by hand

1. `http://localhost:4000/skills` -> `skill-runtime-probe`. Each command should report the runtime
   as available. A blocker here means `SANDBOX_RUNTIME_IMAGE` is missing or not digest-pinned.
2. From chat, ask an Agent to run each command through the `skill` Tool in `run` mode:

   - "Run the `probe_shell` command of the `skill-runtime-probe` skill and show me the raw result."
   - Repeat for `probe_python`, `probe_typescript`, `probe_inline`, `probe_network`.

   Each result should name its own interpreter (`GNU bash ...`, `Python 3.11.2`, `Node v26.7.0`).
   `probe_inline` should report `5`, `20`, `5`, `20` for the four inline forms. `probe_network`
   should report `curl.status: 200`, a byte count for `wget`, and
   `undeclaredDestination: refused`.

   The point of asking for the **raw result** is that a model cannot fake it: ask for the exact
   Node patch version or a `crypto.randomUUID()` and only real execution answers correctly.

3. From chat, ask an Agent to run the code this Skill documents in a fenced block, which reaches
   `skill` in `shell` mode rather than `run` mode:

   - "Open the `skill-runtime-probe` skill and actually run the `node <<'JS'` block in it."
     Expect `20`, not a description of what it would print.
   - Repeat for the `node -e`, `python3 -c` and `python3 <<'PY'` blocks — `5`, `5`, `20`.
   - "Now run `cat /etc/passwd` using that skill." Expect a refusal naming the declared patterns;
     nothing in `allowedCommands` covers it.
   - "Run `node -e \"console.log(1)\" ; cat /etc/passwd`." Expect a refusal for chaining, even
     though the first command on its own is allowed.

4. Whole scripts in a fence, not just single commands — same Tool, wrapped in a heredoc so the
   interpreter reads the body instead of the shell:

   - "Run the multi-line `bash <<'SH'` block." Expect `HELLO WORLD 1..3`; note it contains a `for`
     loop and a pipe, which as a bare command would be refused for chaining.
   - "Run the `python3 <<'PY'` script block." Expect `30`.
   - "Run the `tsx <<'TS'` block." Expect `2,4,6` — TypeScript annotations and all.
   - "Run the `bash <<'SH'` block that has `cat /etc/passwd` after `SH`." Expect a refusal:
     past the closing delimiter the shell reads commands again, and that one matched no pattern.

   A fence tagged ```` ```python ```` rather than ```` ```bash ```` holds a bare script. Ask the
   Agent to run it and it should wrap the body in `python3 <<'PY'` itself. The Skill must still
   declare that interpreter, so wrapping grants nothing the author did not.

   Reproduce the same chain headlessly with:

   ```bash
   SANDBOX_RUNTIME_IMAGE=<repo@sha256:...> \
     pnpm --filter @tulipfarm/skill-sandbox verify:skill-bash
   ```

   It lifts every fenced block out of `SKILL.md` and runs it, so a fence that drifts from what
   actually runs fails the check instead of quietly misleading the model.

## The contract each entrypoint obeys

```
docker run --read-only --network=none --cap-drop=ALL --user <uid>:<gid>
  /tulip/input/entrypoint/<file>   the entrypoint, read-only
  /tulip/input/artifacts/0-input.json   the Tool arguments, as JSON
  /tulip/output/result.json        the result the command MUST write
```

Interpreter is chosen from the file extension: `.sh` -> `bash`, `.ts`/`.tsx` -> `tsx`,
`.py` -> `python3`. Any other extension is refused.

Two content rules apply to every bundled asset before it runs:

- Text matching a package install (`npm install`, `pip install`, `apt install`, ...) rejects the
  asset. Dependencies belong in the image, not in a Run.
- Text matching a direct mutating network call from a command-line HTTP client is refused unless
  the ToolContract declares `allowedDestinations`.

## Calling a URL or an API

Two supported paths, for different jobs.

### From a sandbox command: `curl` and `wget`

Allowed when the ToolContract declares `allowedDestinations` and the caller names one. The
ToolContract carries that choice:

```yaml
- name: ProbeNetwork
  type: tool
  toolRef: { name: skill-runtime-probe-network, version: "1" }
  action: probe
  destination: example.com      # must appear in the contract's allowedDestinations
```

The container never gets a route of its own. `DockerNetworkEgressPort`
(`packages/sandbox/src/development-egress.ts`) puts the workload on an `--internal` Docker network
whose only peer is an allowlisting forward proxy:

```
workload ──> tulip-egress-<key>  (--internal: no default route)
                   │
              proxy container ──> bridge ──> internet
                   └── allowlist: the declared hosts, ports 80/443 only
```

So an undeclared host fails at the proxy, not on the honour system. `probe_network` asserts both
halves: `example.com` returns 200 to curl and to wget, and undeclared `example.org` is refused.

Note the environment carries both `HTTPS_PROXY` and lowercase `https_proxy` — curl ignores an
uppercase `HTTP_PROXY` by design and wget reads only the lowercase names.

### From the Agent: `web_fetch` and `api_request`

Better for anything decided at run time, since the Agent never shells out. `api_request` takes
structured arguments and can lease a one-use credential. Both are brokered, SSRF-guarded, and
narrowed by `assertSkillDestination` (`apps/api/src/tools/network/compose.ts`) to the active Skill's
`allowedDomains` frontmatter. This fixture declares `example.com` and `httpbin.org`.

## Inline code, and code inside `SKILL.md`

The interpreter comes from the **entrypoint file extension** (`commandFor` in
`packages/sandbox/src/development-container.ts`), and `staticArgs` are appended *after* the
entrypoint path. So `node -e "..."` can never be the command form itself.

It works fine *inside* a `.sh` entrypoint, which is what `probe_inline` proves. All four forms run:

```bash
node -e 'console.log(2 + 3)'        # -> 5
node <<'JS' ... JS                  # -> 20
python3 -c 'print(2 + 3)'           # -> 5
python3 <<'PY' ... PY               # -> 20
```

Fenced code inside `SKILL.md` is **prose for the model, never a program**. Nothing in the repo
extracts or executes it — the only fenced-block parser is `effort-signals.ts`, which scores prompt
complexity. To make code run, put it in a real file under `scripts/` and name it as an `entrypoint`.

## Known gaps this fixture cannot cover

- **Authoring a ToolContract.** No Tool, route or UI writes `tools/<slug>/tool.yaml`; only
  Integration compilation produces ToolContracts, and it does not persist them there. That is why
  this fixture is installed by a script instead of through a product surface.
