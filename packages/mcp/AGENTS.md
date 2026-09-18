# MCP (`@tulipfarm/mcp`)
Identity-bound MCP client, bounded discovery, Streamable HTTP, and isolated stdio.

## Read on / Skip
- **Read on if** changing MCP wire behavior, transport isolation, or protocol discovery.
- **Skip if** changing account selection, OAuth storage, grants, or Knowledge policy.

## Map
| Path | Owns |
| --- | --- |
| `src/client.ts`, `src/types.ts` | Public client operations, handles, admission, and limits. |
| `src/transports.ts` | SDK boundary, HTTP credential injection, bounded stdio framing. |
| `src/local.ts` | Development containers and production Kata VM streaming, with the same egress and process limits. |
| `src/oauth.ts` | Guarded SDK OAuth primitives; the host persists state and credentials. |
| `src/catalog.ts` | Verified publisher setup metadata, never capability authority. |
| `src/errors.ts` | Safe typed failures; no raw server/credential exception messages. |

## Rules
- Host admission is mandatory, including public servers. Discovery grants nothing.
- Credentials are explicit inputs. Never inherit host environment or log server stderr.
- `localCredentials.environment` supplies a bounded immutable map to isolated backend `open`.
- Do not use SDK stdio: it inherits ambient environment even with an explicit env.
- Local commands execute only in isolated backends, never directly on the host.
- Production requires strong isolation. The Kata backend always forces `io.containerd.kata.v2`;
  it never falls back to Docker's default runtime. Ordinary containers remain development-only.
- Kata requires an operator-installed Linux/KVM host and the supported Docker/QEMU setup:
  [Docker runtimes](https://docs.docker.com/engine/daemon/alternative-runtimes/) and
  [Kata installation](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-kata-with-docker.md).
- OAuth account lifecycle belongs to Integrations/Secrets, not the SDK transport.
- OAuth helpers require host URL approval, issuer/resource binding, and advertised S256 PKCE.
- No automatic mutation retries, identity switching, roots, sampling, or elicitation.
- SDK revisions are pinned and negotiated honestly. No 2026 protocol support is claimed.
- Server annotations and content are untrusted; the host owns admission and disclosure.
- Error `httpStatus` describes the MCP endpoint, never proof that a provider source was deleted.
