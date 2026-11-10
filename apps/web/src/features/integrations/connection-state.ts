type ConnectionState = 'connected' | 'pending' | 'attention' | 'disconnected' | 'refreshing';

export function accountConnectionState(account: { state: string; identity: unknown | null }): ConnectionState {
  if (account.state === 'disconnected') return 'disconnected';
  if (!account.identity) return 'pending';
  if (account.state === 'active') return 'connected';
  if (account.state === 'refreshing') return 'refreshing';
  return 'attention';
}

export function slackConnectionState(slack: { state: string; scopes: readonly string[] }): ConnectionState {
  if (slack.state === 'active') return 'connected';
  if (slack.state === 'disconnected') return 'disconnected';
  if (
    ['reconnect-required', 'permissions-required', 'scope-missing'].includes(slack.state) ||
    (slack.scopes.length > 0 && ['reserved', 'authorizing', 'failed', 'revoked'].includes(slack.state))
  )
    return 'attention';
  return 'pending';
}
