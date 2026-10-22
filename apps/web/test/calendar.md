# Verify calendar meetings

Run these commands from the repository root. Install dependencies first. See
verification prerequisites for Chromium and local PostgreSQL.
Set `TEST_ADMIN_DATABASE_URL` to the disposable local server described there.

```sh
pnpm exec turbo run build --filter=@tulipfarm/worker --filter='@tulipfarm/web^...'
node --test packages/google-workspace/test/calendar-events.test.mjs packages/google-workspace/test/operation-provider.test.mjs apps/web/test/calendar-read.test.mjs
node --test packages/conversations/test/integration/calendar.test.mjs packages/google-workspace/test/operations.integration.mjs apps/worker/test/calendar.integration.mjs
node apps/web/test/calendar.browser.mjs
node apps/web/test/chat-readiness.browser.mjs
node apps/web/test/chat-integrations.browser.mjs
pnpm check:logged --continue=always
```

The calendar browser suite uses fixture HTTP responses and a controlled clock.
It writes light and dark desktop and mobile captures to ignored `reports/calendar/`.
The `home-mobile-*-meetings.png` captures show the scrolled meetings section.
Set `CALENDAR_PORT` when port 5398 is occupied.

The database suites use real restricted workspace logins, Google service adapters,
and local provider responses. The compiled worker suite verifies actual tool-call
capture and source authorization before a subsequent model request. These tests
do not prove a live Google account or production deployment.
