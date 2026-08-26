#!/usr/bin/env bash
# Inline code, in the four forms a Skill author reaches for. All of them run, because the
# interpreter is chosen from the *entrypoint file extension* and never from argv: a `.sh`
# entrypoint is free to start `node` and `python3` itself.
set -euo pipefail

arguments="${TULIP_INPUT_DIR}/0-input.json"
message="$(jq -r '.message // "no message"' "${arguments}")"

node_flag="$(node -e 'console.log(2 + 3)')"

node_heredoc="$(node <<'JS'
const x = 10;
console.log(x * 2);
JS
)"

python_flag="$(python3 -c 'print(2 + 3)')"

python_heredoc="$(python3 <<'PY'
x = 10
print(x * 2)
PY
)"

echo "probe-inline.sh received: ${message}" >&2

jq -n \
  --arg echoed "${message}" \
  --arg node_flag "${node_flag}" \
  --arg node_heredoc "${node_heredoc}" \
  --arg python_flag "${python_flag}" \
  --arg python_heredoc "${python_heredoc}" \
  '{ok: true, runtime: "shell+inline", echoed: $echoed, inline: {
      "node -e": $node_flag,
      "node <<JS": $node_heredoc,
      "python3 -c": $python_flag,
      "python3 <<PY": $python_heredoc
   }}' \
  > "${TULIP_OUTPUT_DIR}/result.json"
