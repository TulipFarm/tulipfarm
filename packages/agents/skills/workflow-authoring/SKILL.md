---
name: workflow-authoring
title: Draft a workflow
description: Draft or update an automated workflow for human review. Use it whenever someone wants work to happen on a schedule, when a row is created or changed, from a webhook, or as a repeatable sequence of steps, even if they do not say "workflow". Also use it to enable or disable one.
---

# Draft a workflow for review

Use this procedure when a person wants work to repeat or run automatically: on a schedule, when a row changes, from a webhook, or on demand. You prepare a draft; a human reviews it on a chat card.

When the request also needs tables, agents, or integration checks, use Planning in the default chat and keep this workflow as a deliverable in that same plan. Research the actual trigger and action support first. A saved draft does not prove activation or a successful end-to-end run.

## 1. Start from what exists

Use `workspaceInventory.workflows` in the system reminder first when supplied. It contains readable workflow IDs, names, revisions, and enabled/active state: metadata, not full definitions. Do not call `workflows.list` just to repeat that inventory or before creating a new workflow.

When the person asks for a new workflow, omit `workflowId` and `revision` so the draft creates one, even if an existing workflow looks similar or was saved earlier in this chat. Edit an existing workflow only when the person clearly asks to change that workflow; if it is unclear, ask which they want.

Call `workflows.list` when the inventory is absent, needed trigger or step summary details are missing, or a stale response requires a fresh revision. Its result is also a summary, not a full definition. Before editing, call `workflows.read` with the workflow ID and preserve every unrelated setting and step from that full definition. Pass its `workflowId` and exact `revision` to `workflows.draft`. To only enable or disable a workflow, pass `workflowId` and `activate` without a definition. To remove workflows, call `workflows.archive` with each `workflowId` and exact `revision` (up to 20 on one card). To bring archived workflows back, call `workflows.list` with `archived: true`, then `workflows.restore` with each `workflowId` and exact `revision`; restored workflows stay disabled until activated with `workflows.draft`. Human review and current permission checks still apply.

## 2. Read the reference you need

The full shapes are in two references. Read them with `skills.read` and `resource` before you draft:

- `references/table-triggers.md`: record triggers (run relative to a row's date) and row triggers (run when a row is created, updated, or deleted). Read it whenever the trigger involves a table.
- `references/steps.md`: every step kind, values, conditions, and table steps. Read it for every draft that has more than a simple `human`, `delay`, or `transform` step.

## 3. Build the definition

`workflows.draft` takes `definition` as a JSON string `{"version":1,"name","triggers":[...],"steps"}`.

`triggers` lists 0 to 20 triggers, and any of them can start a run, so one workflow can mix kinds, for example a daily cron, two one-time dates and a webhook. Use one trigger per schedule, date or event source rather than one workflow each. An empty list is a workflow people only start by hand. Each trigger is `{"id","label"?,"kind",...}`: `id` matches `^[a-z][a-z0-9_]{0,47}$` and is unique in the workflow, such as `"daily_digest"`; when editing, keep each existing trigger's `id`. `label` is an optional short name people see. The kinds:

- `{"id","kind":"cron","expression":five numeric fields "minute hour day-of-month month day-of-week","timezone":IANA zone}`
- `{"id","kind":"once","at":future ISO datetime,"timezone"?:IANA zone}`
- `{"id","kind":"interval","minutes"}`
- `{"id","kind":"webhook"}`
- `{"id","kind":"event","name"}`
- `{"id","kind":"provider","integrationId","event":"created" or "updated","minutes":1 to 1440}`: first call `workflows.providers` and use a returned configured source. Only Sheets supports `updated`. Never invent integration IDs or ask for tokens in chat.
- `{"id","kind":"record",...}` or `{"id","kind":"row",...}`: see `references/table-triggers.md`.
- `{"id","kind":"github","repositories","events":[{"event","actions"?}]}`: runs when GitHub sends one of those events for a connected repository. First call `workflows.providers`; `repositories` is a list of `repositoryId` values from `githubRepositories`, or `{"organizationId":ownerId,"includeFuture":true}` for every repository of that account. Never guess IDs. List 1 to 8 events, each once: `star` (created, deleted), `watch` (started), `issues`, `pull_request`, `issue_comment`, `release`, `push` (no actions). Omit `actions` to run on every action. The run input has `event`, `action`, `repository` (owner/name), `sender` (the GitHub login) and `senderUrl` (their profile), plus `stars` (the repository's star count after the event) for `star` and `watch`, and `issue`, `pullRequest`, `comment` or `release` for those events. Other GitHub events, such as pull request reviews or check runs, are not supported. The TulipFarm GitHub App must be installed on the repository; the card says so.

A run's input is the data of the trigger that started it. To act differently per trigger, use a condition on `{"kind":"trigger","path":["id"]}` (compared with a trigger `id`) or `{"kind":"trigger","path":["kind"]}` (compared with a kind, or `"manual"` for a run started by hand).

Use the person's stated timezone. Ask when it is unknown; a wrong timezone silently runs the work at the wrong hour.

`steps` holds 1 to 32 steps with unique ids matching `^[a-z][a-z0-9_]{0,47}$`. A step reads earlier results through values:

- `{"kind":"literal","value"}`
- `{"kind":"input","path":[]}`
- `{"kind":"step","step":earlier step id,"path":[]}`

Get table and field IDs from `tables.definitions`.

For connected-provider work, distinguish a native workflow step from an agent step and a generic HTTP request. Read the agent and HTTP sections of `references/steps.md` before declaring that no supported path exists. Inspect a suitable saved agent with `agents.list` and `agents.read`; do not assume its tools grant access or waive approvals. If the required action or setup is missing, name that gap rather than asking the person to enable a nonexistent workflow action.

`workflows.providers` lists only trigger sources and GitHub trigger repositories, not chat connections. An empty result never means Slack or GitHub is disconnected. To post to Slack, resolve the channel with `slack.resolve` and use a Slack message step. Before drafting one, offer message options as `references/steps.md` describes under Message wording: each preview is a `present.choice` option, at most four. Public data, such as public GitHub repositories, can be read with an HTTP step or an agent step without a connected source, but that output can never become Slack message text.

## 4. Activation and review

Set `activate` to true when the person wants the workflow running. Scheduled, record, row, and webhook runs use the person as sponsor.

Only `workflows.draft` creates a draft, and its review card is the only proof one exists. Never say a draft is ready, pending review or created unless `workflows.draft` returned it in this turn; if you still need answers, ask them and say no draft exists yet.

Then ask the person to review each trigger, its next run, and the read-only diagram in Canvas. Edits stay in the chat composer; the chat card records explicit saving and activation approval. Chat text never approves. Webhook keys, new provider integrations, and secret rotation stay on the Workflows setup page. Existing connected-app triggers can be edited through chat using the authorized sources above.
