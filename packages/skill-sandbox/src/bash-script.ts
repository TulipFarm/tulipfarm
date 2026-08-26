/** Cap on each captured stream, so a runaway loop cannot fill the output Artifact. */
export const BASH_STREAM_LIMIT_BYTES = 1 << 20;

export interface BashCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/**
 * Wrap an approved command in the entrypoint script the sandbox runs.
 *
 * Two properties matter and are easy to lose:
 *
 * - The command is carried as base64 and decoded at runtime rather than interpolated into the
 *   script. base64 is `[A-Za-z0-9+/=]` only, so no command — however many quotes, newlines or
 *   heredocs it contains — can terminate the surrounding script and change what else runs.
 * - The wrapper always exits 0. A non-zero command exit is *data* the caller asked for, not a
 *   sandbox failure; letting it become the container's exit code would discard the stdout the
 *   model needs to see exactly when it most needs to see it.
 */
export function buildBashScript(command: string): string {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return `#!/usr/bin/env bash
set -uo pipefail

__tulip_cmd="$(mktemp)"
__tulip_out="$(mktemp)"
__tulip_err="$(mktemp)"
printf '%s' '${encoded}' | base64 -d > "$__tulip_cmd"

bash "$__tulip_cmd" > "$__tulip_out" 2> "$__tulip_err"
__tulip_code=$?

TULIP_CODE="$__tulip_code" \\
TULIP_OUT="$__tulip_out" \\
TULIP_ERR="$__tulip_err" \\
TULIP_LIMIT="${BASH_STREAM_LIMIT_BYTES}" \\
python3 -c '
import json, os

limit = int(os.environ["TULIP_LIMIT"])


def read(path):
    with open(path, "rb") as handle:
        raw = handle.read(limit + 1)
    return raw[:limit].decode("utf-8", "replace"), len(raw) > limit


out, out_cut = read(os.environ["TULIP_OUT"])
err, err_cut = read(os.environ["TULIP_ERR"])
target = os.path.join(os.environ["TULIP_OUTPUT_DIR"], "result.json")
with open(target, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "exitCode": int(os.environ["TULIP_CODE"]),
            "stdout": out,
            "stderr": err,
            "truncated": out_cut or err_cut,
        },
        handle,
    )
'
exit 0
`;
}
