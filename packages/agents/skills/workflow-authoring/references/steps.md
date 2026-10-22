# Workflow steps

`steps` holds 1 to 32 steps with unique ids matching `^[a-z][a-z0-9_]{0,47}$`.

## Values

A value is `{"kind":"literal","value"}`, `{"kind":"input","path":[]}`, or `{"kind":"step","step":earlier step id,"path":[]}`.

## Basic steps

- `{"id","kind":"human","prompt","timeoutSeconds":60 to 2592000}` asks a person to respond.
- `{"id","kind":"delay","seconds"}`
- `{"id","kind":"wait-until","at":value holding an ISO datetime}`
- `{"id","kind":"transform","fields":{name:value}}`
- `{"id","kind":"code","language":"javascript" or "python","source","input":value}`

Code steps need a configured isolated runner. A human step asks for input; it does not approve a provider action.

## Agent step

`{"id","kind":"agent","agentId","prompt":value,"limits"?:{"toolCalls","activeMilliseconds","credits"}}` starts a task for an existing saved agent and waits for its result. The prompt must resolve to a nonempty string of at most 8000 characters. Its output is `{"taskId","result":text}`.

Use `agents.list` and `agents.read` to inspect a saved agent before selecting its exact ID. The person starting the run, or the sponsor of an unattended run, and the workflow history audience must have permission to invoke it. The agent still needs its own active configuration, scope, tools, integrations, and credits. A workflow or skill grants none of these.

Limits default to 100 tool calls, 300000 active milliseconds, and 100 credits. Their allowed ranges are 1 to 1000 tool calls, 1000 to 3600000 active milliseconds, and 1 to 10000 credits.

An agent step is not a native provider action. It can use only the agent's permitted tools and their provider approval rules. Do not promise unattended Slack messages just because an agent has a Slack tool. If no eligible agent exists, explain what must be set up; do not invent an agent ID or send a one-off message instead.

## HTTP step

`{"id","kind":"http","method":"GET", "POST", "PUT", "PATCH" or "DELETE","url":HTTPS URL,"headers"?:{header:value},"body"?:value,"credential"?:{"integrationId","header"?:header name}}` makes a request and outputs `{"status","headers","body"}`.

The URL is fixed, not a mapped value. Header values must resolve to strings. Header names must be lowercase; `authorization`, `cookie`, `proxy-authorization`, `host`, and `content-length` are forbidden. GET and DELETE cannot have a body. Other bodies are JSON-encoded.

Credentials refer to an existing workflow-provider integration, not an ordinary chat integration. The credential header defaults to `x-api-key`. Do not put secrets in the URL, headers, body, or workflow definition, invent integration IDs, or use HTTP to bypass provider permissions or approvals.

An HTTP response is not proof of provider success: the step records its status and body without interpreting provider errors. An idempotency header does not guarantee the remote service deduplicates a repeated request. HTTP is not a native Slack send step.

## Slack message

`{"id","kind":"slack-message","destinationId","text":value,"sender"?:"app" or "user"}`

`{"id":"notify","kind":"slack-message","destinationId":"existing destination UUID","text":{"kind":"input","path":["values","field UUID","value"]}}`

Resolve the destination with `slack.resolve`; never guess or use a raw
Slack channel ID as `destinationId`. Map a text value (1–4,000 characters), not an
entire row or typed value object. A Tickets row-created trigger can read its title
from `values / <title field UUID> / value`.

Before drafting a Slack step, ask the user whether it should post as the
TulipFarm app (`"sender":"app"`) or as the requester's or sponsor's personal
Slack account (`"sender":"user"`). Do not choose for them. The app must already
be a member of the channel. Omitting `sender` posts from the personal account.
Chat sends outside a workflow always use the person's own account.

Each run needs its requester (manual/event) or sponsor (unattended) to approve
the exact message within 24 hours. Saving or activating the workflow does not
approve its messages. Lost access to the destination or its sources stops the
action. Run history shows the exact message, approval controls, and delivery status.
Only a confirmed send completes the step, with `actionId`, `status:"sent"` and
`sentMessageTs` (the outbound message timestamp).
An unknown delivery is terminal: inspect Slack before making a new request.
This step sends one message; it does not grant recurring send permission.
For this first slice, do not map message text from agent or HTTP outputs, including
through transforms or code. Their outbound source evidence is not supported yet.

## Table steps

- `{"id","kind":"find-rows","tableId","filters":[{"fieldId","op":"eq", "ne", "lt", "lte", "gt" or "gte","value":value} or {"fieldId","op":"is-null" or "not-null"}],"limit":1 to 50}` outputs `{"tableId","rows":[{"recordId","token","values"}],"more"}` and filters only text, number, yes or no, date and timestamp fields.
- `{"id","kind":"create-row","tableId","fields":{fieldId:value}}` adds a row.
- `{"id","kind":"update-row","tableId","row":value,"fields":{fieldId:value}}` changes the mapped fields of the row named by row, which must resolve to an object with `"recordId"` and `"token"`, such as a found row, a create-row or update-row output, or a record run's input.

create-row and update-row output `{"operation","tableId","recordId","token","fieldIds"}`.

Get table and field IDs from `tables.definitions`; field IDs are lowercase. A mapped value may be a typed value copied from a found row, or plain JSON: a string for text, date, timestamp or an option ID or label, a number or decimal string for numbers, true or false, a record ID for a relationship, an array for several options, or null. File fields cannot be written or read.

Table steps act with the table permissions of the person who starts the run, or the sponsor for scheduled, record, row and webhook runs. The sponsor needs read and create or update permission, and everyone who sees run history needs read permission.

An update with a token older than the row fails instead of overwriting a newer change.

## Condition step

`{"id","kind":"condition","when":{"left":value,"op":"eq", "ne", "lt", "lte", "gt" or "gte","right":value} or {"left":value,"op":"is-empty" or "not-empty"},"ifMet":[later step id],"otherwise":[later step id]}` checks a comparison and outputs `{"matched","ran","skipped"}`.

- A step listed in `ifMet` runs only when the comparison holds.
- A step listed in `otherwise` runs only when it does not.
- Unlisted steps always run. A skipped step leaves no output.
- List at least one step, and each step in at most one branch.
- A step may read only the outputs of steps that run whenever it runs.

How values compare:

- Typed table values such as `{"kind":"numeric","value":"12"}` are compared by the value inside, and a missing value counts as empty.
- Only typed table numeric values and JSON numbers compare by value; decimal strings outside typed numeric values compare as text.
- JSON exponent numbers compare by value after their exponent is expanded.
- ISO dates or times compare as instants, for equality and order alike.
- lt, lte, gt and gte otherwise compare only two strings; any other pair, or a malformed table number, fails the run.
