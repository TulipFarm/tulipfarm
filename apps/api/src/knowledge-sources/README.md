# Knowledge source sync

Concrete API source stores and scoped account callbacks live here. Selected-file MCP sync and
source-backed publication belong to `@tulipfarm/knowledge`; the integration-worker owns scheduling.

- Slack indexing and its provider-specific live authorization are retired. The only legacy
  schedule hook removes persisted Slack indexing schedules on upgrade; it never starts a consumer.
  Explicit authored Pages still use the normal Page authorization path.
- `mcp/` persists explicit personal selections and publishes read-only MCP Pages with normal Page
  and source indexes. It never grants authored-note access or trusts cached provider output.
- Every use rechecks the actual viewer's current account and source access. Confirmed account loss
  hides copies immediately and schedules retryable erasure; transient reads never prove deletion.

See the [supported MCP source contract](../../../../packages/knowledge/src/mcp/README.md).
