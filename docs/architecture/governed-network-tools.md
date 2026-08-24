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

## Neither Tool performs inference

A Tool is I/O. Given the same arguments and the same destination response, both Tools produce the
same result, every time, with no model consulted and no provider spend.

This is not a style preference. A Tool that summarises has three defects at once:

- **The evidence is gone.** Whatever the summariser dropped can never be recovered by the Agent,
  by a later Turn, or by an operator reading the Run. The only record of the page is one model's
  paraphrase of it.
- **The audit trail lies.** The effect ledger records a fetch. What actually happened was a fetch
  plus an unlogged, unattributed, unbounded model call whose cost lands on no Turn's budget.
- **The attack surface doubles.** The summarising call reads attacker-controlled bytes with no
  guardrail between the page and the prompt, inside a component whose failure looks like a
  network fault.

So `web_fetch` returns the page's whole readable content, rendered to Markdown
deterministically, and `api_request` returns the whole response the destination gave. Neither
result depends on why it was asked for.

Both Tools do accept an optional `prompt`. Neither Tool reads it. It is the Agent's own
statement of what it is looking for, carried past the Tool to the distiller below, and it is
deliberately kept out of the cached payload — the cache is keyed on the URL alone, so a prompt
inside the payload would serve one caller's question to the next.

The two Tools teach the argument differently, because only one of them is cheap to re-ask.
`web_fetch` is cached, so its description invites a second read under a new prompt. `api_request`
is not cached and may be mutating, so its description says the opposite: state everything you need
the first time. The `prompt` is excluded from the effect ledger's idempotency key
(`packages/tool-host/src/effect-ledger.ts`), so rewording it can never make a mutating call look
like a different one.

## Where the summarising went

Long results are distilled once, in the Turn, by `ToolResultDistillerPort`
(`packages/agent-runtime/src/loop/distill.ts`, implemented in `apps/worker`).

- A result under the threshold reaches the model untouched. Most do.
- A larger one is summarised on the cheapest rung against **the prompt the Agent wrote**, falling
  back to the Turn's own latest ask when the Agent wrote none. The Agent's wording is preferred
  because a follow-up Message is written for someone already reading along: "who wrote it?" names
  no subject, and the distiller never saw the Message it refers to. The summary carries
  citations. Every citation whose quote is not verbatim in the fetched content is
  dropped before the Agent sees it, so the intermediary cannot invent a source.
- Distillation never fails a Turn. An absent port, a timeout, a provider fault, or an unusable
  answer all fall back to the raw result, truncated to a bound.

A follow-up question is therefore answered by asking the page again, not by remembering it. The
second call hits the cache, costs no network, and re-reads the whole content against the new
question — so nothing has to be guessed in advance about which part of a page a later Turn will
need.

The Tool stays replayable; only the reading of it is model work, and that model work is attributed
to the Turn that caused it — recorded in the same spend ledger as the Turn's own model call, on the
same provider fallback gate, so one outage is not retried twice over and no cost is invisible.

The whole result reaches the distiller, prose **and** the page's own links: a caller may want to
crawl, or to find one link, rather than to read, and dropping half the result before the one
component that knows the ask would decide that for them.

## What comes back is untrusted

A fetched page is attacker-controlled text arriving inside the Agent's transcript, which is the
same threat as an injected message and was previously unguarded. The `tool-result` guardrail stage
screens every Tool result — and every Tool failure reason, because a Tool that talks to a
destination can quote what the destination said.

A blocked result is **not** reported as a denial. The Tool already ran; on a mutating call an
effect has landed, and telling the model otherwise would deny an effect the Turn caused. The call
stays `succeeded` and only its content is withheld.

## Network boundary

- Only `https:` URLs without embedded credentials are accepted.
- Every connection resolves and pins a public IP. Redirects are revalidated before another
  request, and cross-site redirects are returned to the Agent rather than followed. A redirect
  that only adds or drops the `www.` label of the same site over the same scheme and port is
  followed — it is the most common redirect on the web — but never while the request carries a
  credential, because a subdomain can be taken over independently of its apex.
- Loopback, link-local, private, carrier-grade NAT, documentation, benchmark, multicast, reserved,
  and metadata destinations are refused for IPv4 and IPv6.
- Response bytes, redirects, and wall-clock time are bounded before content is exposed.
- `web_fetch` accepts HTML, Markdown, text, JSON, and PDF. A PDF is taken as undecoded bytes and
  put through the same extractor an attached one uses; every other binary is refused, by leading
  bytes as well as by declared content type, so a mislabelled response cannot get through.
- HTML is rendered with the concealed parts removed first — `<script>` and `<style>` text, and
  anything the page hides with `hidden` or `display:none`. A renderer that keeps them hands an
  Agent text no human reader would ever have seen, which is where an instruction hides.
- The Tool's own deadline reaches the socket. A request that outlives the Tool that owns it is
  one the Run has already recorded as failed, so a mutating `api_request` could land a write that
  reconciliation then retries. A per-hop socket timeout cannot prevent that on its own, because a
  redirect chain restarts it at every hop; the host's abort signal is threaded from the Tool
  context down to `fetch`, so abandoning the Tool closes the connection it opened.
- The network Tools declare their own execution ceiling rather than raising everyone's. Reading a
  slow website has no bearing on what a key-value read should be allowed to take, and the ceiling
  is what stops one stuck Tool holding a Run. The declaration sits above the per-hop socket
  deadline, so a single stalled hop reports itself as a timeout instead of taking the Tool with it.
- A successful `web_fetch` is cached briefly and keyed by the normalised URL. The cache is read
  after the destination check and before the network budget is charged: authorization must not
  depend on what happens to be in memory, and an answer served from memory sends the destination
  nothing to be budgeted for.
- A refusal by this deployment's own cage is reported as `destination_refused` with the denial
  named, never as the destination's `403`. Both are 403 on the wire, and an Agent told only
  "forbidden" will retry a request that will never be allowed, or report this deployment's policy
  to a person as the provider's decision.
- One Run may make a bounded number of network calls across both Tools together. Exhausting it is
  answered as an outcome, not as a validation error, because the arguments were never malformed
  and a repair would only reproduce the same answer.
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
