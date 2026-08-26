---
name: skill-runtime-probe
description: Development probe that exercises every sandbox runtime language a Skill command can be written in — shell, Python, TypeScript, and inline code — and the governed network Tools. Install it only in a development Soul; it does no business work.
allowedDomains:
  - example.com
  - httpbin.org
allowedCommands:
  - "node -e:*"
  - "node <<'JS'"
  - "python3 -c:*"
  - "python3 <<'PY'"
  - "bash <<'SH'"
  - "tsx <<'TS'"
  - "bash --version"
  - "curl:*"
  - "wget:*"
trustTier: first_party
scripts:
  - scripts/probe.sh
  - scripts/probe.py
  - scripts/probe.ts
  - scripts/probe-inline.sh
  - scripts/probe-network.sh
commands:
  - name: probe_shell
    toolRef: skill-runtime-probe-shell
    runtimeProfile: shell-ts-python-v1
    entrypoint: scripts/probe.sh
    requiredCommands:
      - bash
      - jq
  - name: probe_python
    toolRef: skill-runtime-probe-python
    runtimeProfile: shell-ts-python-v1
    entrypoint: scripts/probe.py
    requiredCommands:
      - python3
  - name: probe_typescript
    toolRef: skill-runtime-probe-typescript
    runtimeProfile: shell-ts-python-v1
    entrypoint: scripts/probe.ts
    requiredCommands:
      - tsx
  - name: probe_network
    toolRef: skill-runtime-probe-network
    runtimeProfile: shell-ts-python-v1
    entrypoint: scripts/probe-network.sh
    requiredCommands:
      - bash
      - curl
      - jq
      - wget
  - name: probe_inline
    toolRef: skill-runtime-probe-inline
    runtimeProfile: shell-ts-python-v1
    entrypoint: scripts/probe-inline.sh
    requiredCommands:
      - bash
      - jq
      - node
      - python3
---

# Skill runtime probe

This Skill exists to prove that the sandbox execution path works end to end. Each command runs one
entrypoint in the `shell-ts-python-v1` runtime profile, reads the Tool arguments, and writes a
result document.

| Command | Entrypoint | Interpreter |
| --- | --- | --- |
| `probe_shell` | `scripts/probe.sh` | `bash` |
| `probe_python` | `scripts/probe.py` | `python3` |
| `probe_typescript` | `scripts/probe.ts` | `tsx` |
| `probe_inline` | `scripts/probe-inline.sh` | `bash`, which then starts `node` and `python3` inline |
| `probe_network` | `scripts/probe-network.sh` | `bash`, using `curl` and `wget` |

## The sandbox contract every entrypoint obeys

- Tool arguments arrive as a JSON file at `$TULIP_INPUT_DIR/0-input.json`.
- The result must be written to `$TULIP_OUTPUT_DIR/result.json`. Without that file the command fails.
- Standard output and standard error are captured as Artifacts.
- The container runs read-only and non-root. It has no network unless the ToolContract declares
  `allowedDestinations`, and even then it reaches only those hosts, through a proxy.

Each command echoes the `message` argument back with the interpreter version, so the result proves
which runtime actually executed.

## Inline code

Two different things get called "inline code" here, and they run by different routes.

**Inside a command entrypoint.** The interpreter for a command is chosen from the **entrypoint file
extension**, never from arguments, so there is no `node -e` *command form*. A `.sh` entrypoint may
still start any interpreter itself, which is what `scripts/probe-inline.sh` does.

**Inside this Markdown file.** The commands fenced below are real. The `skill` Tool in `shell` mode runs one of them in
the same sandbox and returns its actual stdout, stderr and exit code. What may run is decided by the
`allowedCommands` list in this file's frontmatter — not by the fence, and not by the model.

```bash
node -e "console.log(2 + 3)"
```

```bash
node <<'JS'
const x = 10;
console.log(x * 2);
JS
```

```bash
python3 -c "print(2 + 3)"
```

```bash
python3 <<'PY'
x = 10
print(x * 2)
PY
```

```bash
bash --version
```

## Whole scripts in a fence

The blocks above are single commands. A fence often holds a whole **script** instead — several
lines of Python, or a shell loop. Those run by the same route: a heredoc makes the script body
*data* for the interpreter named on the first line, which is the line the allowlist matches.

A multi-line shell script, including a pipe, which as a bare command would be refused for chaining:

```bash
bash <<'SH'
NAME=world
for i in 1 2 3; do
  echo "hello $NAME $i" | tr a-z A-Z
done
SH
```

A Python script of several statements:

```bash
python3 <<'PY'
total = 0
for i in range(1, 5):
    total += i * i
print(total)
PY
```

TypeScript, type annotations and all:

```bash
tsx <<'TS'
const double = (n: number): number => n * 2;
console.log([1, 2, 3].map(double).join(","));
TS
```

The heredoc body may contain anything — `;`, `|`, `&&`, newlines — because the interpreter reads
it rather than the shell. What the shell reads is only the first line, and the closing delimiter
must be the last thing in the block. A command placed after the delimiter is a second command the
pattern never matched, so it is refused:

```bash
bash <<'SH'
echo ok
SH
cat /etc/passwd
```

If a fence is tagged with a language rather than `bash` — a ```` ```python ```` block holding a
bare script — the model wraps it in the matching heredoc before running it. The Skill still has to
declare that interpreter in `allowedCommands`, so wrapping grants nothing the author did not.

These are refused, and each shows a different rule:

```bash
cat /etc/passwd
```

Nothing in `allowedCommands` covers it.

```bash
node -e "console.log(1)" ; cat /etc/passwd
```

The first command is allowed, but the chained second one was never matched by anything, so the whole
line is refused.

A pattern ending in `:*` matches a prefix at a word boundary, so `node -e:*` never matches
`node -edit`. A pattern without it must match the whole command. An empty or missing
`allowedCommands` list refuses everything.

The allowlist states what this Skill meant to offer. It is **not** what makes running safe — any
pattern naming an interpreter permits arbitrary code in that language. Safety comes from the
sandbox: read-only, non-root, every capability dropped, and no network route at all unless a
destination was declared.

## Reaching a URL or an API

There are two paths, and they are not interchangeable.

**From a sandbox command (`curl`, `wget`).** Allowed only for destinations the command's
ToolContract declares in `allowedDestinations`, and only when the caller names one. The container
still has no route of its own: it is attached to an internal Docker network whose single peer is an
allowlisting proxy, so an undeclared host is refused at the proxy rather than trusted to the script.
`probe_network` proves this — it fetches `example.com` with both clients and confirms that
`example.org`, which is not declared, is refused.

**From the Agent (`web_fetch`, `api_request`).** The right choice for anything the model decides at
run time, because the Agent never has to shell out. `api_request` takes structured arguments and
supports a one-use leased credential. Both are narrowed to the `allowedDomains` in this Skill's
frontmatter: while the Skill is active, a host outside that list is refused with "the active Skill
does not declare this destination".

Use the sandbox clients for a fixed, declared endpoint that a script needs. Use the Agent Tools for
anything else, and never shell out to an HTTP client just to avoid declaring a destination.
