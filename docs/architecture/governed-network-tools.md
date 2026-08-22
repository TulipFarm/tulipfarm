# Governed network Tools

Status: Accepted architecture contract

## Decision

TulipFarm exposes public HTTPS reads through `web_fetch` and structured HTTP/GraphQL requests
through `api_request`. They are first-party Tools, so validation, authority, Approval, Secret
leases, audit, and durable effect handling stay on the existing Tool path.

`api_request` has a conservative mutating catalog declaration and a pure, server-owned call
classifier. After argument validation and before authorization, the Tool Host derives the exact
action, mutation state, destination, and idempotency policy for that call. The derived contract is
the contract authorized, approved, recorded in the effect ledger, retried, and executed. A
GraphQL operation is parsed structurally: queries are reads, mutations are writes, and
subscriptions are refused. REST `GET`, `HEAD`, and `OPTIONS` are reads; every other method is a
write.

The Agent loop may schedule the Tool conservatively as a write. This can reduce concurrency for
reads but cannot broaden authority or race an effect.

## Network boundary

- Only `https:` URLs without embedded credentials are accepted.
- Every connection resolves and pins a public IP. Redirects are revalidated before another
  request, and cross-origin redirects are returned to the Agent rather than followed.
- Loopback, link-local, private, carrier-grade NAT, documentation, benchmark, multicast, reserved,
  and metadata destinations are refused for IPv4 and IPv6.
- Response bytes, redirects, and wall-clock time are bounded before content is exposed.
- `web_fetch` accepts HTML, Markdown, text, and JSON. Binary content is refused in v1.
- Shell syntax such as `curl` or `wget` is input to translate into structured arguments; it is
  never executed.

## Skill and Secret authority

A Skill may declare `requiredSecrets` and `allowedDomains` in frontmatter. These declarations are
requirements, not grants. At dispatch, the caller's authority, Agent authority, active Skill
declarations, destination, and exact-key `secret.use` grant intersect. An absent declaration or
grant denies.

Secret plaintext is leased only inside the transport callback. It is never placed in model input,
Tool arguments/results, logs, audit payloads, or caches. Direct Chat use of a Secret requires an
exact Approval for the Secret key and destination. Missing credentials return a typed result that
links an authorized operator to the prefilled Secrets page; the request can be retried after setup.

Stable provider workflows with durable identity, sync, or webhook behavior remain declarative
Integrations rather than generic requests.
