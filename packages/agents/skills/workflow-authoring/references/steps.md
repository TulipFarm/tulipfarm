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

`{"id","kind":"slack-message","destinationId","text":value or template,"sender"?:"app" or "user"}`

`{"id":"notify","kind":"slack-message","destinationId":"existing destination UUID","text":{"kind":"input","path":["values","field UUID","value"]}}`

A template is `{"kind":"template","template":text,"values":{name:value}}`. Each run
replaces every `{{name}}` in `template` with its value, which must resolve to text,
a number, a boolean or null (shown as nothing). Map 1 to 16 values, each used at
least once, with names matching `^[a-z][a-z0-9_]{0,47}$`. The filled text must be 1 to
4,000 characters. Values follow the same source rules as any message text.

### Message wording

A notification is read by people in a busy channel, so draft it rather than
restating the trigger. Unless the person gave the exact wording, write two to four
options in different styles, such as a short upbeat one with an emoji, a concise
plain one, and a fuller one with links and details. Use the run's data through a
template: who did it, what changed, a link to it, and a useful count or state.
Write each option fresh for this workflow and its audience; do not reuse fixed
example text.

Ask with `present.choice`, and make each choice label the preview itself: the
message as the channel would read it, filled with realistic sample values, under
256 characters. Offer at most four choices, recommended first. Say in the prompt
that the values are samples. Do not also list the previews in prose, and do not
combine the wording with another question such as the sender; ask that separately
afterwards. Draft only the chosen option. Keep the message to one to three lines.

The text is rendered as standard Markdown: `**bold**`, `_italic_`, `[label](url)`
and line breaks. Write emoji as Unicode characters, at most two, and keep them
relevant to the event. Never add `@channel`, `@here` or mentions the person did not
ask for. A value from outside data, such as an issue title, is posted as written;
keep it out of link URLs unless it is a URL field such as `url` or `senderUrl`.

Resolve the destination with `slack.resolve`; never guess or use a raw
Slack channel ID as `destinationId`. Map a text value (1–4,000 characters), not an
entire row or typed value object. A Tickets row-created trigger can read its title
from `values / <title field UUID> / value`.

Before drafting a Slack step, ask the user whether it should post as the
TulipFarm app (`"sender":"app"`) or as the requester's or sponsor's personal
Slack account (`"sender":"user"`). Do not choose for them. The app must already
be a member of the channel. Omitting `sender` posts from the personal account.
Chat sends outside a workflow always use the person's own account.

Each run posts its message to the channel straight away, without a separate
approval. Lost access to the destination or its sources stops the action. Run
history shows the exact message and its delivery status.
Only a confirmed send completes the step, with `actionId`, `status:"sent"` and
`sentMessageTs` (the outbound message timestamp).
An unknown delivery is terminal: inspect Slack before making a new request.
This step sends one message; it does not grant recurring send permission.
Message text cannot come from agent or HTTP output, including through a
transform or a code step's input: the send is refused when the run reaches it,
and `workflows.draft` rejects such a draft. Use literal text, run input,
table step output, or a template of them. A report built from fetched or agent-written data cannot be
posted by a workflow Slack step; tell the person so instead of drafting one.

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
