# Shared feature queries

Implementation inspected on 2 October 2026. Public exports live in `index.ts`.
Feature consumers still own REST adapters, response validation, key factories,
mutation recovery, and change-to-query rules.

## Read API

```ts
useFeatureRead<T>({
  key: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  pollLoad?: (data: T, signal: AbortSignal) => Promise<T>,
  enabled?: boolean,
  staleTime?: number,
  pollWhile?: (data: T) => boolean,
  interval?: number | ((checks: number) => number),
  maxChecks?: number,
  maxDuration?: number,
}): {
  state: ReadState<T>,
  refresh: () => Promise<void>,
  delayed: boolean,
}
```

`ReadState` is the existing type in `features/tables/request-state.ts`.
An initial read is loading until success or failure. Only a successful response
can establish an empty result. Refreshes retain data and report local errors.
HTTP 401, 403, and 404 remove retained query data and return `unavailable`.
HTTP 401 revokes the session cache. Table 403 and 404 do not revoke unrelated
workspace queries. Explicit workspace revocation clears its protected scope.

The context prepends `['user', userId, 'workspace', workspaceId, 'membership',
membershipId]`. Account context prepends `['user', userId]`. Consumer keys are
feature-local, JSON-compatible prefixes. Keys contain every response-changing
input and never contain credentials, invitation tokens, or OAuth tokens.

```ts
const scope = useFeatureScope();
if (scope.kind !== 'workspace') throw new Error('Workspace admission required');

const balance = useFeatureRead({
  key: ['credits', 'balance'],
  load: signal => readBalance(scope.workspaceId, signal),
  pollWhile: () => true,
  interval: 15_000,
  maxChecks: Infinity,
});

const progress = useFeatureRead({
  key: ['conversations', 'detail', chatId, 'progress'],
  load: signal => readProgress(scope.workspaceId, chatId, signal),
  pollWhile: data => data.status === 'running',
  staleTime: freshness.chat,
});
```

Polling defaults to 2 seconds and 30 checks. One scheduler and budget serve a
query key in each tab. All consumers of a key must use the same polling policy.
No additional QueryObserver is created for polling. Hidden or offline tabs pause.
Visibility return waits a full interval and does not reset the budget. An explicit
`refresh()` resets that query's budget. Polling stops on a read error or when the
last interested reader leaves. `Infinity` supports unbounded credits polling.
An optional `maxDuration` limits elapsed time from the first scheduled progress
check, including hidden/offline time and request latency. No new progress check
starts at or after that deadline; an already running read may finish. An optional
`pollLoad` refreshes the cached result during progress checks only, under the same
abort and authority fences. Initial reads, manual Refresh, and concealed
revalidations use `load`; manual Refresh cancels an in-flight partial read first.

Freshness defaults are `ordinary: 60_000`, `catalog: 900_000`, and `chat: 30_000`.
Inactive memory retention is 30 minutes. Focus never refreshes feature queries.
Reconnect refreshes stale active visible queries. Hidden changes mark data stale
until a normal read trigger. Retries cover network failures, timeouts, HTTP 408,
429, and 5xx, with at most two retries. A transport error's optional `retryAfter`
property accepts seconds or an HTTP date and is bounded to 1–30 seconds.
Transport adapters that discard this header use ordinary exponential backoff.
Writes never retry or queue for reconnect.

## Changes and scope

```ts
const { change } = useFeatureChanges();
await saveSomething();
await change({
  keys: [
    ['conversations', 'detail', chatId],
    ['conversations', 'list'],
    ['credits', 'balance'],
  ],
});
```

`change({ keys: readonly QueryKey[] }): Promise<void>` accepts feature-local
prefixes in the hook's current scope. It retains data, coalesces same-tick
invalidations, cancels pre-change reads, and refreshes matching active visible
queries. The promise resolves after those refresh attempts. Read errors appear
in each read's state. An empty `keys` array changes nothing. A key of `[]`
invalidates the whole current scope. Captured change handlers remain usable after
component unmount while their session and membership remain admitted.

For a confirmed change that can affect visibility, use
`change({ kind: 'conceal', keys })`. This cancels pre-change reads and removes
their data immediately in both tabs before revalidation. The notification carries
only scoped key prefixes. Receiving it never broadcasts another notification.
Existing `change({ keys })` calls retain their ordinary invalidation behavior.
`FeatureChange` is exported from `index.ts`.

Hidden concealed queries revalidate once after their full normal interval when
visible and authorized, even when their previous result was idle or their progress
budget was exhausted. This read does not reset or consume the progress budget.
An error stops automatic polling and exposes the existing retry action.

Cache-authority observers use `runtime.applyChange(scope, input)` for the same
local behavior without broadcasting. Only confirmed feature changes use
`runtime.change(scope, input)` or the hook's `change` to notify other tabs.
The provider authority helper accepts an optional binding projection so display
changes, such as team names, can be excluded from authority comparisons.

Workspace admission subscriptions deliver `admitted`, `empty`, or `denied`
snapshots. An `empty` navigation fence calls `runtime.suspend(scope)` to cancel
old reads while retaining memory and persisted data. Only an explicit
`denied` event for the observed admission calls `runtime.revoke(scope, true)`.
Subscriptions that invoke listeners without an event remain supported as local
navigation fences; authority owners must send `denied` or call `revoke` directly.

`useFeatureScope()` returns the discriminated `FeatureScope` union. `featureKey`
and `scopeKey` construct full keys for direct QueryClient operations.
`featureReadOptions(runtime, scope, input, admitted?)` exposes the same abort and
authority fences for prefetching with `runtime.client.fetchQuery`. The runtime
must be the provider's existing `FeatureClient`, never a second client.

BroadcastChannel messages contain version, event ID, session ID, scoped identity,
change kind, and key prefixes. They contain no response data. Receivers validate
and deduplicate events without rebroadcast. Old-session logout cannot revoke a
replacement session. Unsupported channels fall back to per-tab operation.

## Early reads during admission

Workspace admission can start a page's first reads before the provider exists
(`early-reads.ts`). `startEarlyReads(identity, workspaceId, reads)` runs each
`{ key, load }` and registers the result under the user, workspace and feature
key. The router binds the entries to the membership with `admit(membershipId)`
once admission succeeds, and calls `discard()` on denial, failure or abort.

`featureReadOptions` takes a matching entry before calling `load`. An entry is
used once, only for the same session, workspace and admitted membership, and only
within ten seconds of settling. A failed early read is never handed over: the
query reads again with its own loader, so denial handling stays with the query.
The data still passes the query's authority fence. `applyChange` discards
entries under the changed keys, and `revoke`, `suspend` and `stop` discard every
entry for their scope.

Early reads must use the same key and loader inputs as the page's first query.
`features/chat/early-reads.ts` lists them for the chat list, an opened chat and
the project list. The router skips any read the session cache already holds.
On a fresh load it also starts the membership read from the workspace id the
slug had at the last admission (`workspaceIdHint`). It uses that result only when
the workspace read returns the same id, and forgets the hint on 403 or 404.

The API checks the session cookie on every read, so a fresh load does not wait
for the session read before starting these reads. `lastSession()` in
`lib/last-workspace.ts` remembers the user and session the router last confirmed.
The workspace, workspace list, hinted membership and page reads start for that
session alongside `get-session`. Admission uses them only when the session read
returns the same user and session; otherwise it discards them and reads again.

## Provider admission

`SessionQueryProvider` accepts explicit `identity: SessionIdentity | null`,
`children`, and optional `onAuthorityLost(scope)`. The auth SDK owns that identity.
The callback conceals matching route content and asks the SDK and router to
revalidate authority. The router mounts one provider per
session and keeps it across workspace navigation and unchanged auth refreshes.
`WorkspaceQueryProvider` accepts `scope`, `admitted`, `subscribe`, and `children`.
Its admission callback checks the existing workspace access revision. No query
module imports the router.

Ready workspaces obtain the current membership from `governance/me` during route
admission. Focus access checks read it again and compare it with the admitted
membership. A new membership ID denies the old admission. A changed role, team
role, or capability under the same ID updates a cached membership read, conceals
governance dependents, and re-admits the workspace. An unchanged authority leaves
feature data and editor state alone. Provisioning workspaces retain the account
scope until membership admission becomes available. On 5 October 2026,
`test/governance-authority.browser.mjs` covered demotion and promotion on focus
for Members, and demotion for Models without a loaded governance view.

Workspace denial and membership replacement cancel protected reads and clear
catalog snapshots and persisted reads. Cancellation checks run after the transport resolves, even
when the transport ignores its AbortSignal. Logout detaches and clears the old
client. StrictMode cleanup does not broadcast a false logout.

## Persisted reads and provisional admission

[`persisted-reads.ts`](./persisted-reads.ts) keeps selected query data in the
`tulipfarm-query-cache` IndexedDB database so a return visit can show it before
the network answers. Only reads listed in `persistedPageReads`
(`features/chat/early-reads.ts`) persist: the first page of the active chat list
per project filter (up to 4), the first history page of the 12 most recently
saved chats, and the project list. Each definition matches keys with a zod
schema and validates data with the response schema its feature API already uses.

Each record's envelope holds version, user, workspace, membership, name, key and
data timestamp. Records older than 24 hours, future-dated, corrupt, wrong-scope
or failing their schema are rejected and pruned. A record over 1 MB is not saved,
and a user's records are capped at 3 MB, evicting the oldest first. Saves are
debounced, fenced by the current membership, and skipped while the scope is
unconfirmed. Values written with `setQueryData` are not persisted. IndexedDB
failures leave normal network and memory reads available.

On admission the router saves the workspace snapshot (user, workspace, workspace
list and membership) with the session id and session expiry. On a fresh load
of a workspace page, other than `/<slug>/integrations…`, the router reads that
snapshot for the last session. When it is younger than 24 hours, its session
has not expired, and it loads within 300 ms, the route admits it at once with
`workspaceProvisional: true`. `WorkspaceQueryProvider` seeds the persisted reads
with their original timestamps, marked stale, so queries refetch in the
background. The real session and admission check runs alongside. `holdWrites`
in `lib/http.ts` makes every non-GET request wait for it, and fails them unless
the check returns the same user, session, workspace and membership.

When the check confirms the snapshot, the router swaps in the confirmed context
and saves the current reads. Any other result clears that workspace's persisted
data and admits again as a fresh load would: no session or 401 redirects to
login, 403 or 404 denies the workspace and shows not found, and a different user
or membership replaces the scope, which revokes the old one.

Persisted reads are cleared:

- for every user on logout (`LogoutPage`);
- for the user on a missing session or 401 (`forgetSession`), on query-client
  retirement, and when a different user signs in (`rememberSession`);
- for the workspace on revoke, denial, membership replacement, and a provisional
  check that does not confirm; and
- per key on a denied read and when dependents are concealed.

Chat content on disk is readable by anyone with access to the browser profile.

## Catalog persistence integration

The model catalog persists separately. The model feature's
[`useModelCatalog`](../../features/models/use-model-catalog.ts) calls
`useCatalogRestoration` alongside its read:

```ts
const key = ['models', 'catalog'];
const restored = useCatalogRestoration(key);
const catalog = useFeatureRead({
  key,
  load: signal => readModelCatalog(workspaceId, signal),
  enabled: restored,
  staleTime: freshness.catalog,
});
```

Only the model catalog calls this opt-in hook. The runtime deduplicates
restoration before readers start. It restores the original `dataUpdatedAt`, marks
the restored catalog stale so each page load re-reads it once in the background, and
persists successful values only after validation with the existing
`@tulipfarm/config/model-catalog` schema. The envelope includes version, user,
workspace, membership, and original data timestamp. Snapshots expire after 24
hours. Corrupt, future-dated, wrong-scope, and incompatible snapshots are rejected.
IndexedDB failures leave normal network and memory reads available.

`createCatalogPersistence` also exposes `restore(scope, current)`,
`save(scope, catalog, updatedAt, current)`, and `clear(userId, workspaceId?)`.
The `current` callback must include fresh session and workspace membership
admission. `prepareCatalog(scope, key, admitted)` handles this for a FeatureClient.
Revocation fences pending opens and writes before deletion. Model availability
from disk is display data. The server still validates sends.

## Public reads and deliberate receipts

Signed-out routes have no feature-query context.
[`PublicAuthQueryProvider`](../../features/auth/public-query.tsx) owns a separate
memory-only client inside the auth layout. `useAuthOptions` passes that client
explicitly to `useQuery`. It caches only the public Turnstile site key, omits
credentials, and never persists sessions or challenge tokens. Concurrent readers
share the request. Focus and reconnect do not refresh it; failed reads expose
the existing verification retry action.

[`receipt-queries.ts`](../../features/settings/receipt-queries.ts) supplies named
settings, availability, and fallback receipt readers for settings and account
recovery. Each calls the session client's `fetchQuery` only when
`useSettingsCommand` checks a retained command. Keys include the account,
workspace, channel, and complete command. Account ownership permits recovery
after workspace removal. Reads always check the server, never retry or queue for
reconnect, and keep the command hook's original ID and explicit retry behavior.

The production `useRead` and `useResourceRead` hooks have been removed. The resource
browser test now exercises only shared queries. Historical request measurements
remain in the baseline and
integration evidence.

## Verification boundaries

Focused checks:

```sh
pnpm --filter @tulipfarm/web typecheck
pnpm --filter @tulipfarm/web exec node --test test/query-foundation.test.ts test/query-foundation.browser.mjs
```

Core tests cover shared reads, invalidation races, denial scope, bounded and
unbounded polling, hidden resume, reconnect, snapshot validation, and IDB races.
The browser test exercises React providers and two actual BroadcastChannels.

Return-visit checks:

```sh
pnpm --filter @tulipfarm/web exec node --test test/persisted-reads.test.ts test/http.test.ts
VITE_API_URL= pnpm --filter @tulipfarm/web build
pnpm --filter @tulipfarm/web exec node --test test/provisional-workspace.browser.mjs
```

The provisional test needs the production build: on the Vite dev server the
disk snapshot loads after the 300 ms provisional wait. Reads that succeed before
persisted reads are configured are saved once configuration finishes.

Ready-workspace fixtures supply `governance/me` membership responses. Feature
consumers use named queries and dependent-scope concealment for grant changes.
Startup, navigation, and focus measurements are recorded in the dated
integration evidence, along
with its test failures and remaining browser acceptance gaps. That run's full
`pnpm check` failed at the unrelated agents schema wire-size assertion, `70128`.
The measurements do not prove actual OS background-tab suspension behavior.

Final cleanup verification on 2 October 2026:

- Web typecheck and repository lint passed. The catalog check covers 85 UI modules.
- `node --test test/public-query.browser.mjs test/auth-turnstile.browser.mjs test/resource-query.browser.mjs`
  passed all three browser tests. Public options deduplicate concurrent readers,
  survive reader remounts in memory, ignore stale focus and reconnect events, and
  leave local storage, session storage, and IndexedDB empty. Auth tests cover
  failed verification reads, repeated retry, challenge renewal, and retained input.
- `node --test test/settings.browser.mjs` passed 39 scenarios plus the parent test.
  All three account receipt channels wait for a deliberate check, preserve the
  original command after 503 and 404 responses, and resolve without writes.
  Existing scenarios cover lost writes, reload, deletion recovery, account
  isolation, mismatched receipts, and deliberate retries with identical IDs.
  The first run exposed an incomplete fallback fixture; the corrected full run passed.
- `pnpm check` passed 83 of 85 tasks, including all 66 web unit tests, before the
  known agents wire-size failure stopped the run. Deployment tests were interrupted.

Browser checks use Chromium with controlled HTTP or fetch responses. This cleanup
does not add live backend receipt authorization, live Turnstile, or OS background
suspension evidence. The core query implementation is unchanged by the cleanup.
