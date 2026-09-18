# Connect Linear

**Coming soon:** production activation is blocked on fixed GraphQL provider verification.
See [the package guide](setup-guide-oim.md) for the tested operations and exact activation,
polling and Knowledge boundaries. The steps below apply once the verification gate is supported.

TulipFarm uses a Linear personal API key. The key is encrypted in the secrets store and is sent only
to Linear's API for the fixed operations this integration publishes.

1. In Linear, open **Settings → Security & access → Personal API keys**.
2. Create a key for TulipFarm and restrict it to the teams and permissions it needs. Read access is
   enough to list and read issues; enable write, issue creation, or comment creation only when agents
   should perform those actions.
3. In TulipFarm, open **Integrations → Linear**, paste the key, and choose **Connect**.
4. Ask in chat to list Linear teams, then read an issue. Creating, updating, and commenting require
   approval before TulipFarm sends the request.

Teams, issues, workflow states and members page with `first` (1–50) and `after`. Continue until
`pageInfo.hasNextPage` is false; a single page must not be reported as a complete list.
Issue lists are ordered by newest activity.

Before changing status or assignee, discover workflow states and active members for the issue's
team. Updates accept `stateId`, `assigneeId`, `priority` (0 none, 1 urgent, 2 high, 3 normal, 4 low),
and `estimate`, as well as title and description. Omit unchanged fields; `null` clears an assignee
or estimate. Automatic event polling and Knowledge indexing are not available.
