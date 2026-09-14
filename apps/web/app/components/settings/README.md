# Settings components

Shared panels and controls for the Settings routes in `app/routes/`.
The existing Settings section shell supplies the page title, gutters, and scroll region.
The sidebar switches to the destinations in `app/lib/nav.ts`.

## Map

- `memory-document-panel.tsx` displays the system-maintained Memory document.
- `memory-document-panel.test.tsx` covers the read-only Memory presentation.
- `telemetry-level.tsx` shares the telemetry disclosure and reporting-level radio group.
- `../../routes/_app.settings.telemetry.tsx` owns the admin telemetry screen.
- `../../routes/settings-telemetry.test.tsx` covers the screen's interaction and error paths.
- `../../routes/setup.tsx` also uses the disclosure and level picker before completion.
- `../../lib/telemetry.ts` defines the API response and typed request wrappers.
- `../../lib/setup.ts` sends the chosen `telemetryLevel` during setup completion.

## Telemetry choices

Level 0 is the mandatory one-time bootstrap report.
It includes installation/host/version metadata and configured business and URL metadata.
Level 1 adds daily counts.
Level 2 adds bounded names and is the default, subject to the deployment cap.
Names and bootstrap metadata can identify a business; never describe reporting as anonymous.
Lowering the level to 0 disables daily reporting and retains the mandatory bootstrap.
The disclosure links to the public telemetry policy for the complete field list.

The deployment environment supplies `maxLevel`; the picker cannot raise it.
The server enforces the limit again when saving and dispatching a report.
Development and tests expose the preference UI but disable delivery.
An upgraded installation's daily reporting stays paused until an administrator saves.
Setup completion records the selection, so a new wizard installation has an explicit preference.

## Preview and saving

`GET /api/v1/system/telemetry` returns saved settings and candidate payloads.
`GET /api/v1/system/telemetry?level=N` previews a level without saving or sending it.
`PUT /api/v1/system/telemetry` accepts `{ level: N }` and returns the saved settings.
The page renders the returned JSON; it does not reconstruct a report from other APIs.
The report IDs and times for a new daily report can change at dispatch.

Requests begin in event handlers, never inside state updaters.
A monotonically increasing request number prevents stale responses replacing newer previews.
Changing the choice immediately removes the old preview.
Saving stays disabled until the current preview has loaded successfully.
A failed preview offers a retry; a failed save preserves the choice and paused status.
Delivery history shows only the server-confirmed timestamps, with explicit empty states.

## Access and verification

`useIsAdmin` controls access to the screen; the API separately enforces administrator authority.
The server's navigation registry controls visibility of `/settings/telemetry`.
The radio group uses native keyboard navigation, a legend, and distinct labels/descriptions.
Payload regions support keyboard scrolling without expanding the whole page horizontally.

Run focused checks when verification is requested:
`pnpm --filter @tulipfarm/web test app/routes/settings-telemetry.test.tsx app/routes/setup.test.tsx app/lib/setup.test.ts`
`pnpm --filter @tulipfarm/web typecheck`
