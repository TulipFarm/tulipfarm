# Instant chat box on a return visit

## Problem

A cold visit to a workspace home downloads about 1.85 MB (brotli) before the
composer works. On slow 3G that is about 20 s of a blank page. Loading the
chunks in parallel did not help: the link is full, so only fewer bytes or UI
before the JavaScript can move the first usable moment.

## Approach

`apps/web/index.html` paints a static copy of the home layout (sidebar
skeleton, header, composer) before any script downloads. It shows only when:

- `tulipfarm:last-session` holds a session,
- the path is `/<slug>` with no search, and
- `<slug>` is in that user's `tulipfarm:workspace-ids:<userId>` map.

The person can type at once. Enter marks the message to send when the app is
ready.

When the real chat mounts, `takeEarlyComposer()` reads the typed text, removes
the copy, and hands the text to the new-chat prefill path. If Enter was
pressed, the prefill auto-sends once a model is available. If the first route
resolves anywhere other than the workspace home, or the chat fails to load,
the copy is removed and the text dropped.

## Not done

- No feature flag: the copy runs before PostHog loads.
- Only the workspace home path. Chat and other pages keep the current load.

## Check

- `sim2.mjs` A/B on slow3g, fast3g and 4g: first contentful paint and the
  time to a focusable composer.
- Founder review of the swap on a return visit, in both themes.
