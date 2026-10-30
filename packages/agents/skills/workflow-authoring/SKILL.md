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

Call `workflows.list` when the inventory is absent, needed trigger or step summary details are missing, or a stale response requires a fresh revision. Its result is also a summary, not a full definition. Before editing, call `workflows.read` with the workflow ID and preserve every unrelated setting and step from that full definition. Pass its `workflowId` and exact `revision` to `workflows.draft`. To only enable or disable a workflow, pass `workflowId` and `activate` without a definition. Human review and current permission checks still apply.

## 2. Read the reference you need

The full shapes are in two references. Read them with `skills.read` and `resource` before you draft:

- `references/table-triggers.md`: record triggers (run relative to a row's date) and row triggers (run when a row is created, updated, or deleted). Read it whenever the trigger involves a table.
- `references/steps.md`: every step kind, values, conditions, and table steps. Read it for every draft that has more than a simple `human`, `delay`, or `transform` step.

## 3. Build the definition

`workflows.draft` takes `definition` as a JSON string `{"version":1,"name","trigger","steps"}`.

`trigger` is one of:

- `{"kind":"cron","expression":five numeric fields "minute hour day-of-month month day-of-week","timezone":IANA zone}`
- `{"kind":"once","at":future ISO datetime}`
- `{"kind":"interval","minutes"}`
- `{"kind":"manual"}`
- `{"kind":"webhook"}`
- `{"kind":"event","name"}`
- `{"kind":"provider","integrationId","event":"created" or "updated","minutes":1 to 1440}`: first call `workflows.providers` and use a returned configured source. Only Sheets supports `updated`. Never invent integration IDs or ask for tokens in chat.
- `{"kind":"record",...}` or `{"kind":"row",...}`: see `references/table-triggers.md`.
- `{"kind":"github","repositoryId","event","actions"?}`: runs when GitHub sends that event for a connected repository. First call `workflows.providers` and copy a `repositoryId` from `githubRepositories`; never guess it. `event` and its `actions`: `star` (created, deleted), `watch` (started), `issues`, `pull_request`, `issue_comment`, `release`, `push` (no actions). Omit `actions` to run on every action. The run input has `event`, `action`, `repository` (owner/name) and `sender` (the GitHub login), plus `issue`, `pullRequest`, `comment` or `release` for those events. The TulipFarm GitHub App must be installed on the repository; the card says so.

Use the person's stated timezone. Ask when it is unknown; a wrong timezone silently runs the work at the wrong hour.

`steps` holds 1 to 32 steps with unique ids matching `^[a-z][a-z0-9_]{0,47}$`. A step reads earlier results through values:

- `{"kind":"literal","value"}`
- `{"kind":"input","path":[]}`
- `{"kind":"step","step":earlier step id,"path":[]}`

Get table and field IDs from `tables.definitions`.

For connected-provider work, distinguish a native workflow step from an agent step and a generic HTTP request. Read the agent and HTTP sections of `references/steps.md` before declaring that no supported path exists. Inspect a suitable saved agent with `agents.list` and `agents.read`; do not assume its tools grant access or waive approvals. If the required action or setup is missing, name that gap rather than asking the person to enable a nonexistent workflow action.

## 4. Activation and review

Set `activate` to true when the person wants the workflow running. Scheduled, record, row, and webhook runs use the person as sponsor.

Then ask the person to review the trigger, the next run, and the read-only diagram in Canvas. Edits stay in the chat composer; the chat card records explicit saving and activation approval. Chat text never approves. Webhook keys, new provider integrations, and secret rotation stay on the Workflows setup page. Existing connected-app triggers can be edited through chat using the authorized sources above.
