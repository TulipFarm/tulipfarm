---
id: channel-linking
area: Channel Linking
suites: [smoke, full]
routes: ["/link-channel"]
preconditions: [signed-in session, integration-worker running on :4030]
blast_radius: UI-only testing on /link-channel; never completes real third-party OAuth handshakes
est_minutes: 8
smoke_scenarios: [S1]
---

# Channel Linking

Channel Linking (`/link-channel`) connects external messaging channels (Slack channels, Telegram groups/chats) to TulipFarm agents and routines. Ingress messages from linked channels route through the integration worker (`http://localhost:4030`) into the Agent Runtime dispatch loop.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Channel linking view and platform selection

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /link-channel` | Page loads within 5s; heading `Link Channel` or `Channel Linking` |
| 2 | `expect` platform options render (e.g. **Slack**, **Telegram**) with platform icons and descriptions | Options visible |
| 3 | `click` platform option **Slack** | Slack pairing panel expands |
| 4 | `expect` fields for `Team / Workspace ID`, `Channel ID`, and `Target Agent / Routine` render | Form fields present |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S2 — Channel configuration and agent routing form

| # | Action | Expected |
| --- | --- | --- |
| 1 | Select target agent from the `Target Agent` dropdown | List populates with registered soul agents |
| 2 | `type` `Channel ID` `qa-<run-id>-slack-channel` | Input accepted |
| 3 | Select autonomy / approval mode for channel triggers (e.g. `Supervised` vs `Full`) | Selection reflected |
| 4 | `click` `Generate Pairing Code` (or `Link Channel`) | Button enters loading state; pairing instructions or verification token appears |
| 5 | `expect` token/secret is displayed in code block or secret input box, with clear copy action | Token visible and copyable |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S3 — Validation and error state handling

| # | Action | Expected |
| --- | --- | --- |
| 1 | Clear required channel ID field and attempt to submit | Submit blocked or inline validation error "Channel ID is required" renders |
| 2 | Enter invalid channel format (e.g., spaces or illegal characters if prohibited) | Validation message surfaces |
| 3 | Test unlinked channel lookup (`/link-channel?code=invalid-code`) | Graceful error state renders ("Invalid or expired pairing code") |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S4 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through channel linking form controls | Form inputs and platform cards have visible focus indicators |
| 2 | Toggle between Light and Dark themes | Form fields, platform badges, and code blocks remain legible |
| 3 | Resize viewport to 375px mobile width | Platform selection grid and channel form adapt without horizontal overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- UI-only verification: do not perform real OAuth handshakes with external Slack or Telegram workspaces.
- Confirm integration-worker on port `:4030` is reachable during preflight.
