# Shared feature queries

Implementation inspected on 2 October 2026. Public exports live in `index.ts`.
Feature consumers still own REST adapters, response validation, key factories,
mutation recovery, and change-to-query rules.

## Read API

```ts
useFeatureRead<T>({
  key: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  enabled?: boolean,
  staleTime?: number,
  pollWhile?: (data: T) => boolean,
  interval?: number,
  maxChecks?: number,
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
old reads while retaining memory and persisted catalogs. Only an explicit
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
catalog snapshots. Cancellation checks run after the transport resolves, even
when the transport ignores its AbortSignal. Logout detaches and clears the old
client. StrictMode cleanup does not broadcast a false logout.

## Catalog persistence integration

Persistence is opt-in. The model feature's
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

Only the model catalog may call this opt-in hook. The runtime deduplicates
restoration before readers start. It restores the original `dataUpdatedAt` and
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
