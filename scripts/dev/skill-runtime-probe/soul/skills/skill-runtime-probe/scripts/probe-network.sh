#!/usr/bin/env bash
# curl and wget, from a sandbox command that declared its destinations.
#
# The container has no route of its own. Every request goes through the allowlisting egress proxy
# named in the proxy environment, which refuses any host the ToolContract did not declare.
set -euo pipefail

arguments="${TULIP_INPUT_DIR}/0-input.json"
host="$(jq -r '.host // "example.com"' "${arguments}")"
url="https://${host}/"

curl_status="$(curl --silent --show-error --location --max-time 20 \
  --output /tmp/curl-body --write-out '%{http_code}' "${url}")"
curl_bytes="$(wc -c < /tmp/curl-body | tr -d ' ')"

wget_bytes="unavailable"
if wget --quiet --timeout=20 --tries=1 --output-document=/tmp/wget-body "${url}"; then
  wget_bytes="$(wc -c < /tmp/wget-body | tr -d ' ')"
fi

# A destination outside allowedDestinations must fail. Proving the refusal matters as much as
# proving the success, so a misconfigured allowlist cannot pass as a working probe.
blocked="refused"
if curl --silent --max-time 10 --output /dev/null "https://example.org/" 2>/dev/null; then
  blocked="REACHED"
fi

echo "probe-network.sh fetched ${url} via ${https_proxy:-no proxy}" >&2

jq -n \
  --arg host "${host}" \
  --arg proxy "${https_proxy:-}" \
  --arg curl_status "${curl_status}" \
  --arg curl_bytes "${curl_bytes}" \
  --arg wget_bytes "${wget_bytes}" \
  --arg blocked "${blocked}" \
  '{ok: ($curl_status == "200" and $blocked == "refused"),
    runtime: "shell+network",
    host: $host,
    proxy: $proxy,
    curl: {status: $curl_status, bytes: $curl_bytes},
    wget: {bytes: $wget_bytes},
    undeclaredDestination: $blocked}' \
  > "${TULIP_OUTPUT_DIR}/result.json"
