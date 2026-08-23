# RFC: Open Integrations Framework

Status: **Draft — not accepted.** No ADR is allocated until the validation in
[Validation plan](#validation-plan) completes.

Supersedes in scope: [Building an Integration](building-an-integration.md) (declarative egress),
[GitHub App manifest](github-app-manifest.md) (auth steps).

## Summary

A single declarative contract that describes any third-party provider — how agents call it, how it
reaches back, how credentials are obtained, and how its output is shaped for a model. The runtime
ships **adapters**; each integration ships **data**. Installing an integration never means running
someone's code.

Three claims this RFC makes, in order of how much they matter:

1. **Egress and ingress are separate modes** because credentials and trust point in opposite
   directions. They compose; they do not merge.
2. **Ingress terminates in an inbox, not in an agent.** Everything downstream — routines, chat,
   automation — subscribes to a bus fed by that inbox.
3. **A tool is not an API operation.** It is a curated, composite, projected unit of work sized for
   a model's context window.

The framework is provider-agnostic and intended to work outside TulipFarm. Nothing in the manifest
format depends on TulipFarm internals.

## Motivation

Today a provider costs roughly 1,000–5,000 lines of TypeScript. `packages/integrations/src/github/`
is ~4,700 lines across contracts, adapter, events, credentials, scope and entitlement. That cost is
paid again per provider, by us, and it means:

- Operators cannot add a provider. The product promise is that everything is reachable from chat;
  integrations are the largest exception.
- The community cannot contribute one at all.
- Every provider re-implements pagination, retries, signature verification and token refresh
  slightly differently.

The repository already contains most of the mechanism. `packages/integrations/src/egress/`
compiles OpenAPI and GraphQL declarations into Tool contracts. `apps/api/src/ingress/signature.ts`
verifies templated HMAC schemes generically. What is missing is a coherent contract around them,
and four capabilities named in [Gap analysis](#gap-analysis).

### Two generations exist today, pointing opposite ways

| | Shape | Where |
| --- | --- | --- |
| v1 | **Declarative.** `egress: openapi\|graphql\|...`, `auth[]`, `ingress.webhook` | `packages/schema/src/integration-manifest.ts` (named `Legacy*`) |
| v2 | **Not declarative.** `IntegrationAdapter.execution = managed \| externalProtocol`; operations are names only | `packages/schema/src/definitions/integration.ts` |

v2 introduced the identity model that v1 lacked — `App`, `Integration`, `externalAccount`,
`AccessGrant` — but dropped all call description, pointing instead at compiled adapters or a remote
RPC endpoint.

**This RFC is v3: v1's declarative body inside v2's identity skeleton.** It adds a third
`execution.mode: declarative` rather than replacing either.

## Non-goals

- Replacing `execution.mode: managed`. The code path stays, permanently, as the escape hatch.
- Supporting SOAP, WSDL or EDI declaratively. Workday-class providers stay `managed`.
- Letting agents read manifests at run time. See [Compiler input, not context](#compiler-input-not-context).
- A general-purpose programming language in YAML. See [Holding the DSL line](#holding-the-dsl-line).

## Core model

### Egress and ingress

**Egress** — we call them. **Ingress** — they reach us. Direction of initiation determines
everything downstream.

```
   EGRESS                              INGRESS
   agent decides                       provider decides
        |                                   ^
        v                                   |
   [tulipfarm] --our credential--> [slack]  |
                                            |
   [tulipfarm] <--their signature-- [slack] +
```

| | Egress | Ingress |
| --- | --- | --- |
| Who proves identity | we prove to them | they prove to us |
| Timing | we choose | we cannot choose |
| Payload | ours, trusted | theirs, **hostile by default** |
| Volume | bounded by agent turns | unbounded, spiky, replayed |
| Failure means | tool errors, agent retries | event lost, or delivered twice |
| Control point | authority intersection, approvals, destination cage | signature, timestamp window, dedup, principal resolution |

They compose but do not merge: ingress never acts, it hands off to egress. One config shape cannot
hold both stances without weakening both.

`webhook` vs `websocket` vs `poll` is a **different axis** — a transport choice inside ingress.
Trust and verification are identical across all three; only who opens the TCP connection differs.

### Compiler input, not context

The manifest is compiled into Tool contracts at load time. The agent sees ordinary typed tools.

```
  WRONG                              RIGHT
  agent reads manifest.yaml          runtime compiles yaml -> ToolContract[]
  agent decides what to call         agent sees normal typed tools
  agent builds the HTTP request      runtime builds it, checks authority
```

Letting a model read the manifest forfeits determinism, the authorization gate, token budget and
testability. The one exception is **authoring time**: when a user asks in chat for a routine, the
agent reads the `events:` descriptions and sample payloads to know what exists. That is a
documentation read, not an execution path.

## Artifact layout

```
integrations/slack/
├── integration.yaml          # identity, version, what it provides
├── auth.yaml                 # credential identities and how to obtain them
├── egress/
│   ├── openapi.json          # vendored, pinned, checksummed
│   └── tools.yaml            # tool defs, composites, projections
├── ingress/
│   ├── events.yaml           # transports, verification, event declarations
│   └── channel.yaml          # chat-channel capabilities (chat providers only)
├── setup-guide.md            # human prose, rendered in the UI
├── code/                     # escape hatch — only when required
│   └── socket-mode.ts
└── tests/
    ├── cases.yaml
    └── cassettes/*.json
```

Split by concern. A single-file Slack manifest is ~1,500 lines. Small providers may collapse
everything into `integration.yaml`.

```yaml
apiVersion: v1
kind: Integration
metadata: { name: slack, version: 1.4.0 }
spec:
  provider: slack
  execution: { mode: declarative }
  auth:    ./auth.yaml
  egress:  ./egress/tools.yaml
  ingress: ./ingress/events.yaml
  setupGuide: ./setup-guide.md
```

## Egress

### A tool is not an API operation

GitHub's OpenAPI document has roughly 1,000 operations. Compiling all of them produces 1,000 tools
a model cannot choose between and an effect surface nobody can review.

```
  1000 OAS operations
      -> curate ~40 tools
      -> ~15 of those composite
```

The specification is the **catalog**, not the tool list. Rule: an operation becomes a tool only
when someone has written a description a model can act on.

### Composites

One tool may issue many calls. This is the main reason the framework beats raw OpenAPI import.

```yaml
spec: ./openapi.json
baseUrl: https://slack.com/api
auth: { identity: bot, in: header, header: Authorization, format: "Bearer {token}" }

prune:
  drop: [ok, response_metadata, team_id, blocks, bot_profile, client_msg_id]

tools:
  - name: slack_list_channels
    description: List channels the bot can post to.
    operation: conversations.list
    args:
      types: { const: public_channel,private_channel }
    returns:
      path: channels
      select: [id, name, is_private, num_members, topic.value]
      maxItems: 100
      paginate: { cursor: response_metadata.next_cursor, into: cursor }

  - name: slack_post_message
    description: Post a message to a channel by name or ID.
    mutating: true
    args:
      channel: { type: string, description: "#name or C0123ABCD" }
      text: { type: string }
      threadTs: { type: string, optional: true }
    steps:
      - id: resolve
        when: "!args.channel.startsWith('C')"
        call: slack_list_channels
        pick: "channels[?name == '${args.channel | trimStart('#')}'].id | [0]"
        onEmpty: { error: "No channel named ${args.channel}" }
      - id: post
        operation: chat.postMessage
        with:
          channel: "${resolve.result ?? args.channel}"
          text: "${args.text}"
          thread_ts: "${args.threadTs}"
    returns:
      select: [ts, channel]

  - name: slack_read_thread
    description: Read a thread with author names resolved.
    steps:
      - id: msgs
        operation: conversations.replies
        with: { channel: "${args.channel}", ts: "${args.threadTs}" }
      - id: users
        operation: users.info
        forEach: "${msgs.messages[*].user | unique}"
        with: { user: "${item}" }
        concurrency: 5
    returns:
      from: msgs.messages
      select: [ts, text, user]
      join: { on: user, with: users, as: authorName, take: user.real_name }

policy:
  rateLimit: { strategy: header, header: Retry-After, maxRetries: 3 }
  timeoutMs: 15000
```

`slack_read_thread` is the argument in one example: one tool, N+1 API calls, and the model never
sees a user ID.

### Projection

Prior declarative platforms return JSON to a program. This one returns it to a model. A raw
`pulls.get` is roughly 8,000 tokens of URLs, node IDs and nested actor objects.

Projection is therefore mandatory, not an optimisation:

- `prune.drop` — provider-wide noise removal, applied before any per-tool selection.
- `returns.select` — explicit allowlist of fields, dotted paths permitted.
- `returns.maxItems` — hard cap; truncation is reported to the model, never silent.
- `returns.join` — fold a fan-out step back into the primary collection.

Shipping raw provider responses makes an integration technically working and practically unusable.

### Holding the DSL line

`steps:` + `${}` + `pick:` is a small language, and small languages grow. Two options:

- **A. Cap it.** No loops beyond `forEach`, no conditionals beyond `when`, no arithmetic, no
  user-defined functions. Anything more goes to the escape hatch.
- **B. Per-step code.** `run: ./code/resolve.ts` for a single step, YAML stays pure sequencing.

**Recommendation: A, with B available.** A keeps the no-code promise true for the large majority of
tools; B is the pressure valve. B-only means every non-trivial tool needs TypeScript and the
premise collapses.

This is a social constraint as much as a technical one. The failure mode is one reasonable-looking
pull request adding `if/else` to YAML.

## Auth

### Credential identities, selected per call

A provider offers more than one identity. GitHub has an App installation and a user OAuth token;
Slack has a bot token and a user token. Selection belongs on the **tool**, not the integration.
`AuthOAuth2StepSchema` already carries `personal: boolean`, which anticipated this.

```yaml
auth:
  identities:
    - id: app
      kind: jwt_assertion
      algorithm: RS256
      issuerRef: APP_ID
      privateKeyRef: APP_PRIVATE_KEY
      ttlSeconds: 540
      exchange:
        url: /app/installations/${connection.installationId}/access_tokens
        tokenPath: token
        expiresAtPath: expires_at
    - id: user
      kind: oauth2
      personal: true
      scopes: [repo, read:org]
      tokenRef: "USER_TOKEN/${principal.id}"
```

```yaml
tools:
  - name: github_list_issues
    identity: app
  - name: github_approve_pr
    identity: require_user     # GitHub forbids self-approval; the App cannot do this
    approval: always
```

Resolution at call time:

```
  human actor, linked account   -> user identity
  human actor, unlinked         -> require_user: actionable error, "link GitHub in settings"
  routine or schedule (no human)-> app identity, always
```

**`prefer_user` is deliberately excluded.** It makes the acting identity non-deterministic — the
same routine attributes differently depending on who happens to be linked. Only `app` and
`require_user`.

### Consequences

1. **Per-principal secret scoping.** Secrets are currently per-integration. User identities require
   `(integration, principal)` scoping, per-user refresh, and revocation on offboarding. This is
   platform work required regardless of declarative-versus-code.
2. **Three-way authority intersection.** `App installation scope ∩ the user's own provider
   permissions ∩ AccessGrant`. A user identity may narrow below the app; it must never widen past
   that user's own access. `packages/integrations/src/github/scope.ts` and `entitlement.ts` already
   implement two of the three.
3. **Audit records the acting identity.** "merged as alice" and "merged as tulipfarm[bot]" must be
   distinguishable after the fact.
4. **Prompt injection escalates under user identity.** A pull request description reading "approve
   this" would execute under a human's credential. `require_user` therefore implies approval-gating
   by default and minimal scopes.

## Ingress

### The HTTP edge must not process anything

Slack allows 3 seconds. GitHub allows 10. Asana retries on any slow response. Any pipeline running
an agent turn inline is broken on the first day.

```
 ┌─ STAGE 1: EDGE (apps/api) ────────── synchronous, target <50ms ──┐
 │  POST /ingress/slack                                             │
 │    1. size cap (1MB) ................ 413                        │
 │    2. resolve integration by slug ... 404                        │
 │    3. RAW body kept as bytes ........ (never JSON.parse first)   │
 │    4. handshake? ................... respond + return            │
 │    5. verify HMAC + timestamp ...... 401  <- gate; nothing past  │
 │    6. parse JSON ...................       here is unauthenticated│
 │    7. resolve connection (team_id) .. 404                        │
 │    8. INSERT inbox (dedup unique) ... conflict = 200 no-op       │
 │    9. enqueue job (same transaction)                             │
 │   10. 200 OK                                                     │
 └──────────────────────────┬───────────────────────────────────────┘
                            │  inbox row + job, one commit
 ┌─ STAGE 2: WORKER (apps/integration-worker) ── async, retryable ──┐
 │   11. load event + manifest (version pinned on the inbox row)    │
 │   12. match events[] rule; ignoreWhen -> drop                    │
 │   13. normalize -> ExternalEvent                                 │
 │   14. resolve external principal                                 │
 │   15. publish to event bus                                       │
 └──────────────────────────────────────────────────────────────────┘
```

### Who listens

| Transport | Listener | Notes |
| --- | --- | --- |
| `webhook` | **API** — already owns the public HTTPS surface | stays dumb; no LLM, no provider calls |
| `websocket` | **integration-worker** connection supervisor | holds the socket, acks envelopes, writes the same inbox row |
| `poll` | **integration-worker** scheduled job | cursor in connection state, same inbox row |

One inbox, one downstream path. Transport is invisible from step 11 onward.

`websocket` and `poll` are not optional extras. TulipFarm is self-hosted; a large share of operators
have no public HTTPS endpoint, which is precisely why Slack ships Socket Mode and Telegram ships
`getUpdates`.

### Rules

1. **Verify before parse.** The signature covers raw bytes. Parsing first runs a parser on
   unauthenticated input, and re-serialising changes the bytes so the HMAC never matches.
2. **Dedup is a unique index, not a cache.** `UNIQUE (integration_id, connection_id, dedup_key)`.
   Every provider retries; Slack retries when you are slow even though you succeeded. A restart
   must not lose deduplication state and double-post to a customer.
3. **Insert and enqueue in one transaction.** Otherwise the acknowledgement is sent, the process
   dies, and the provider never resends.
4. **Pin the manifest version on the inbox row.** A retry twenty minutes later must not execute a
   different manifest than the original delivery.
5. **Ordering is per-subject, not global.** Global ordering serialises all provider traffic behind
   one slow turn. Two events on one pull request must not race; two different pull requests must
   run in parallel.
6. **The payload never becomes a prompt directly.** Step 13 normalises into a typed
   `ExternalEvent`. The acting principal is the **sender**, never the connection owner.

### Failure and abuse

```
  handler fails
    -> retry, exponential, 5 attempts
    -> then: inbox.status = 'failed', reason stored
    -> visible in the UI, replayable by hand
    -> never dropped silently
```

A poison event must not block its subject forever; after N attempts it is parked and the next event
for that subject proceeds.

The endpoint is public and unauthenticated by definition. Rate-limit per slug **before** HMAC
verification — HMAC over a 1MB body at high request rates is a CPU denial-of-service. Failed
verifications are counted and alerted on; bodies are never logged. An unknown slug returns 404 with
no timing difference from a bad signature.

### Transports in the manifest

```yaml
transports:
  - kind: webhook
    priority: 10
    requires: instance.publicUrl
    path: /ingress/slack
    security:
      type: hmac_sha256
      header: X-Slack-Signature
      timestampHeader: X-Slack-Request-Timestamp
      secretRef: SIGNING_SECRET
      signing: "v0:{timestamp}:{body}"
      format: "v0={hex}"
      toleranceSeconds: 300
    handshake:
      match: { path: type, equals: url_verification }
      respond: { challenge: "${body.challenge}" }
    ackWithin: 3s

  - kind: websocket
    priority: 20
    connect:
      operation: apps.connections.open
      identity: appLevel
      urlPath: url
    protocol: slack_socket          # named; implemented in code/, see escape hatch
    reconnect: { backoff: exponential, maxMs: 30000 }
    ack: { send: { envelope_id: "${envelope.envelope_id}" } }

  - kind: interaction               # component presses; different encoding and verification
    path: /ingress/slack/interactive
    encoding: form_urlencoded
    security: { as above }
    ackWithin: 3s

dedupKey: "${event.event_id}"
```

Runtime selects by priority among transports whose `requires` is satisfied, with an explicit
operator override.

Only one worker may hold a given socket, or duplicate frames arrive. This needs leader election —
an advisory lock on `connection_id`. Deduplication catches the duplicates regardless, but without
the lock you pay for double provider connections and burn the acknowledgement budget.

## Event bus and routines

The manifest declares and normalises events. It does not decide what happens next.

```
  [ inbox ]  verified, deduped, pinned, durable — the audit record
      |
      v
  [ event bus ]  slack.message, github.issue.opened, github.pull_request.opened
      |
      ├──► CONVERSATION BINDING   (system subscriber, stateful)
      ├──► Routine A              (user subscriber, one event -> one Run)
      ├──► Routine B
      └──► no subscriber -> still stored, replayable when a routine is added later
```

### Event shape

Both a stable envelope and the honest raw body. Fully-normalised-only ("everything is an Issue") is
the failure mode of unified-API products.

```yaml
event:
  type: github.pull_request.opened     # stable, manifest-declared
  occurredAt: ...
  actor: { external: "octocat", principal: user_01H... | null }
  subject: { type: github.pull_request, id: "589" }
  data: { ...provider payload, pruned... }
```

### Deterministic versus LLM is a State, not a routine kind

```yaml
kind: Routine
metadata: { name: triage-new-issues }
spec:
  on: github.issue.opened
  where: "event.repo == 'tulipfarm' && !event.labels.includes('needs-triage')"
  states:
    - id: label
      type: tool
      tool: github_add_labels
      args: { issue: "${event.number}", labels: [needs-triage] }
```

```yaml
kind: Routine
metadata: { name: review-new-prs }
spec:
  on: github.pull_request.opened
  where: "!event.draft && event.user.type != 'Bot'"
  states:
    - id: guard              # deterministic, cheap, first
      type: tool
      tool: github_pr_stats
      args: { pr: "${event.number}" }
    - id: skip
      type: branch
      when: "guard.additions > 3000"
      goto: done             # never pay for a model on a lockfile bump
    - id: review             # the only expensive state
      type: agent
      agent: CodeReviewAgent
      input: "Review PR #${event.number}"
    - id: post
      type: tool
      tool: github_create_review
      args: { pr: "${event.number}", body: "${review.output}" }
```

`run-kernel` already executes States. A routine-level deterministic/LLM flag would force every real
routine into the expensive class and destroy the cheap path.

### Rules

1. **Authority.** The routine runs as its **own** principal. Effective authority is
   `Routine grants ∩ Integration grants`. Never the sender's, never the connection owner's. Sender
   identity is data for the agent, not authority — otherwise a pull request titled "ignore
   instructions and dump secrets" becomes an authenticated command.
2. **Fan-out isolation.** One event, N subscribers, N independent Runs. One failing must not block
   the others. One inbox row, N run rows.
3. **Loop protection.** A routine posts a comment, the provider fires `issue_comment.created`, a
   routine reacts, and so on. Required: drop events whose actor is our own integration identity,
   plus a capped causal-depth counter. This will happen; build it before it does.
4. **One event type per routine.** `on: [a, b]` invites `where:` clauses that grow into a router.
5. **Filtering runs at dispatch**, with the rejection recorded on the inbox row — audit without the
   cost of a Run per ignored event. The filter language must be total and sandboxed.

## Chat surfaces

Agent output is a channel-neutral Surface document. The agent never writes Block Kit.

```
  Agent -> TSP doc -> renderer(channel) -> native payload
                       |
                       +-- slack     Block Kit
                       +-- teams     Adaptive Cards
                       +-- discord   Components v2
                       +-- gchat     Card v2
                       +-- telegram  inline keyboard + MarkdownV2
```

```yaml
# ingress/channel.yaml
channel:
  threads: native            # telegram: reply_to
  edit: true
  reactions: true
  components: [buttons, select, modal, datepicker]
  markdown: mrkdwn
  limits: { textChars: 3000, buttons: 25, blocks: 50 }
```

Renderer contract: **must never fail, only degrade.**

```
  select  -> unsupported -> numbered buttons -> unsupported -> "reply with 1/2/3"
  modal   -> unsupported -> post fields inline
  table   -> unsupported -> fixed-width text
```

| | thread | edit | reactions | rich components |
| --- | --- | --- | --- | --- |
| Slack | yes | yes | yes | Block Kit, modals |
| Discord | yes | yes | yes | Components v2, modals |
| Teams | yes | yes | limited | Adaptive Cards |
| Google Chat | yes | yes | limited | Card v2, no modals |
| Telegram | reply_to only | yes | limited | inline keyboard only |

Telegram is the floor. If the Telegram render is usable, every other channel is straightforward.

**Component types are a closed set owned by the framework.** Integrations may not define their own;
that produces an N×M matrix and no portability.

Two mechanics:

- **Message handle.** Edits and reactions need a channel-specific pointer — `{channel, ts}` for
  Slack, `{chat_id, message_id}` for Telegram. Stored per rendered surface as an opaque blob owned
  by the renderer.
- **Reactions are bidirectional.** `reaction_added` is an input event (approve with a check mark)
  and an output primitive (acknowledge with eyes). Declared in both `events:` and the capability
  list.

### Chat is a system subscriber, not a routine

| | Routine | Chat thread |
| --- | --- | --- |
| lifetime | one event, one Run | days, many turns |
| history | none | full Conversation |
| identity | routine's own principal | **the human who typed**, per message |
| output | side effects | Surface render, approvals, streaming edits |

A routine has fixed authority by design; a thread has whoever spoke last. Alice asks, Bob asks
next — different grants, same thread. The routine model has nowhere to put that.

Binding is connection configuration, not manifest content:

```yaml
# soul/integrations/slack/connection.yaml
chat:
  bindTo: slack.thread
  openOn: [app_mention]
  continueOn: [message]
  agent: SupportAgent
  channels: { allow: ["#support", "#eng"] }
```

The stateful behaviour that must survive: once a thread is bound, follow-ups need no mention.

```
  @tulipfarm what's the deploy status?  -> app_mention -> bind -> Conversation
  and staging?                          -> message, no mention -> SAME Conversation
  (unrelated thread) hey team           -> message, no binding -> DROPPED
```

Dispatch performs `subject.id -> conversation_id?`. Present means continue; absent plus an `openOn`
event means create; otherwise drop.

Three mechanics: the edge acknowledges within 3 seconds and the binding posts a placeholder it
later edits as the turn streams; `ignoreWhen: event.bot_id != null` prevents self-echo loops; and
approvals render as native components whose presses arrive on the `interaction` transport.

Routines and chat are not exclusive — a routine may subscribe to `slack.message` for keyword
alerting while a Conversation runs in the same thread.

## Escape hatch

`execution.mode: managed` remains permanently. Additionally, named protocol handlers cover
per-provider framing that does not deserve a DSL:

```ts
// code/socket-mode.ts
export const slack_socket: IngressProtocol = {
  frame: (raw) => JSON.parse(raw),
  isEvent: (f) => f.type === "events_api",
  payload: (f) => f.payload.event,
  ack: (f) => ({ envelope_id: f.envelope_id }),
  onDisconnect: "reconnect",
};
```

Every declarative platform learns the same lesson: roughly 80% of a provider is pure description,
and the remaining 20% — cursor schemes that are not cursors, per-endpoint backoff, SOAP envelopes,
bulk operations that need three calls — is not. Platforms that refused an escape hatch capped out.
It is designed in from day one, not patched in later.

## Provider coverage

Researched against current provider documentation (August 2026).

| Provider | Egress | Auth | Events arrive by | Declarative? |
| --- | --- | --- | --- | --- |
| GitHub | OpenAPI + GraphQL | OAuth2, or App RS256 JWT to 1h installation token | webhook, HMAC-SHA256 raw body | yes, once `jwt_assertion` exists |
| Slack | OpenAPI (`slack_web.json`) | OAuth2 + app manifest | webhook `v0:{ts}:{body}`, **or Socket Mode** | yes, once `websocket` exists |
| Linear | GraphQL only | OAuth2 or API key | webhook, `Linear-Signature` bare hex | yes, needs subscribe lifecycle |
| Jira Cloud | OpenAPI v3 | OAuth2 3LO | webhook + HMAC secret | yes, needs tenant-templated base URL |
| Asana | OpenAPI | OAuth2 or PAT | webhook; **handshake mints `X-Hook-Secret` at runtime** | yes, once secret capture exists |
| Telegram | no OAS; uniform `POST /bot{token}/{method}` | static bot token | `setWebhook` + `secret_token`, **or `getUpdates` long poll** | yes, once `poll` exists |
| HubSpot | OpenAPI per-API | OAuth2 or private-app token | webhook; v3 signs `method+uri+body+ts`, base64 | yes, once signing template widens |
| Workday | REST + WQL (partial), **SOAP (full)** | OAuth2 client credentials + ISU, tenant URL | **no push; polling only** | REST partly; **SOAP stays `managed`** |

Verdict: the declarative approach covers the modern REST/GraphQL-plus-webhook world completely.
Enterprise SOAP stays code, and that is the correct line to draw.

## Gap analysis

What the current schema cannot express. One is structural; the rest are small.

| # | Gap | Hit by | Fix |
| --- | --- | --- | --- |
| 1 | **Outbound-connection ingress** (`websocket`, `poll`) | Slack Socket Mode, Telegram, Workday | `ingress.transports[].kind` |
| 2 | **Runtime-minted secret** — provider generates it at registration; echo then persist | Asana | `handshake.captureSecret: X-Hook-Secret` |
| 3 | **Subscription lifecycle** — create, renew, delete the webhook via the provider's API | Linear, Asana (expiring), Jira, HubSpot, Telegram | `ingress.subscribe / renew / unsubscribe` as declared egress operations |
| 4 | **RS256 JWT assertion auth** | GitHub App, Google service accounts | `auth.kind: jwt_assertion` |
| 5 | **Signing template too narrow** — `{body}`/`{timestamp}`, hex only | HubSpot v3 | add `{method}`, `{uri}`, `format: "{base64}"` |
| 6 | **Static `base_url`** | Jira `{cloudId}`, Workday `{tenant}` | template from `Integration.spec.externalAccount` |

Gap 1 is structural and product-critical: TulipFarm is self-hosted, so outbound-connection ingress
is the *default* deployment, not a fallback.

`apps/api/src/ingress/signature.ts` already verifies GitHub, Slack, Linear, Asana and Telegram with
zero provider code. That part of the bet is proven in production.

## Migration: GitHub

`packages/integrations/src/github/` is ~4,700 lines including tests.

| File | Lines | Verdict |
| --- | --- | --- |
| `contracts/*.ts` | ~950 | to YAML tool definitions |
| `adapter.ts` | 324 | to YAML plus projections |
| `events.ts` | 343 | to `events.yaml`; the generic HMAC verifier already handles it |
| `credentials.ts` | 140 | to builtin `jwt_assertion`, not per-provider code |
| `scope.ts` + `entitlement.ts` | 434 | **stays as code** |

Scope and entitlement stay because they are **authorization**, not integration. `scope.ts` computes
installation scope intersected with AccessGrant, per permission, per repository. Manifests describe
how to call an API; they must never describe who may. The migration usefully forces that separation,
which is currently blurred.

Two prerequisites: `jwt_assertion` (GitHub App is the entire auth story), and the projection layer
(migrating without `select:` makes GitHub worse than today).

**GitHub should not be the first migration.** Its OpenAPI document is excellent, its webhooks are
textbook HMAC, and it has one auth path — passing proves less than it appears. Linear first:
GraphQL with no OAS, composites mandatory, webhook subscription lifecycle over the API, small
enough to finish quickly.

## Authoring and testing

No MCP. The universal interface is a shell command, which every harness can already run.

```
  edit tools.yaml
        |
  oif check ./linear          schema, $ref resolution, egress URL policy — no creds, no network
  oif describe ./linear       compiled operations, argument schemas, token estimate
  oif call ./linear issue.list --args '{"team":"ENG"}'
        |                     real HTTP; prints request, response, token cost
  oif record / oif replay     cassettes
  oif agent "list open ENG issues" --only linear
        |                     boots agent-runtime headless with only this integration's tools
```

```yaml
# tests/cases.yaml
- tool: slack_post_message
  args: { channel: "#eng", text: "hi" }
  cassette: post-by-name.json
  expect:
    calls: [conversations.list, chat.postMessage]
    result: { channel: C0123ABCD }
    maxTokens: 40

- ingress: webhook
  fixture: message-in-thread.json
  expect: { thread: "C0123ABCD:1710000000.000100", conversation: bound }
```

### Distribution

| Tier | Location | Author | Trust |
| --- | --- | --- | --- |
| Core | registry repository | maintainers, reviewed contributions | signed, CI-tested |
| Community | any git repository or URL | anyone | unsigned, explicit operator opt-in |
| Local | `soul/integrations/` | this instance's agents | already how TulipFarm works |

Integrations are **not** vendored into this repository. A separate versioned registry, pinned by
`integrations-lock.json` (the artifact kind already exists), resolved the way a package manager
resolves from a registry.

### CI

| Check | Runs | Requires |
| --- | --- | --- |
| `oif check` | every PR, forks included | nothing |
| cassette replay | every PR, forks included | nothing |
| `oif agent`, scripted tier | every PR | nothing |
| live smoke | nightly and on maintainer label | provider sandbox credentials |

Fork pull requests never see a secret. Same shape as the existing `pnpm eval` versus
`pnpm eval:matrix` gate.

**Cassettes rot.** A provider changes its API, the cassette stays green, the integration is broken
in production. A nightly live job against per-provider sandbox accounts is required from day one, or
the registry decays within months. This is the largest ongoing cost in the proposal and it is
operational, not architectural.

## Open questions

1. Is v2 (`managed` / `externalProtocol`) shipped and in use, or half-built? If shipped, v3 must be
   strictly additive. If half-built, the v1/v2 split can be resolved properly instead.
2. DSL option A or B (see [Holding the DSL line](#holding-the-dsl-line)).
3. Does a Slack thread map to one Conversation, or one per participant? Recommendation:
   one per thread, treating the thread as the privacy boundary, since it already is one in Slack.
4. Where do subscription lifecycle operations run — on connect, on a schedule, or both? Asana
   webhooks expire and Slack app manifests change; renewal needs an owner.
5. Does `oif` ship as a standalone package outside this monorepo? Community authoring depends on it.

## Risks and confidence

Overall confidence: **80%**.

| Component | Confidence | Reasoning |
| --- | --- | --- |
| Declarative egress compilation | 95% | proven; already running in this repository |
| Two-stage ingress, inbox and bus | 95% | well-understood, unexciting |
| Egress/ingress split, authority model | 90% | correct by construction |
| Routines as bus subscribers | 85% | matches the existing run-kernel |
| Surface protocol and renderers | 80% | proven pattern; the Telegram floor is real work |
| Composite DSL | 65% | small languages grow — the largest design risk |
| Projection at scale | 65% | new ground; not solved well elsewhere |
| Registry not rotting | 45% | maintenance cost, not architecture |

The two genuine risks are the DSL growing into a bad programming language, and silent registry
decay. Neither is an architectural objection; both are discipline problems that must be owned by
name.

## Validation plan

Build three integrations end to end **before** this RFC is accepted and before the schema is
frozen:

1. **Linear** — GraphQL, no OAS, mandatory composites, webhook subscription lifecycle.
2. **Slack** — Socket Mode, Block Kit, threads, interactions, dual identity.
3. **One deliberately ugly provider** — Workday or equivalent, to locate the `managed` boundary
   precisely.

If all three fit without a schema change, accept. If the third forces a fourth escape hatch, the
line is drawn in the wrong place and this RFC needs revision, not amendment.
