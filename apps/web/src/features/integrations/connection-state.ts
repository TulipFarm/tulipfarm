type ConnectionState = 'connected' | 'pending' | 'attention' | 'disconnected' | 'refreshing';

export function accountConnectionState(account: { state: string; identity: unknown | null }): ConnectionState {
  if (account.state === 'disconnected') return 'disconnected';
  if (!account.identity) return 'pending';
  if (account.state === 'active') return 'connected';
  if (account.state === 'refreshing') return 'refreshing';
  return 'attention';
}

export function slackConnectionState(slack: { state: string }): ConnectionState {
  if (slack.state === 'active') return 'connected';
  if (['disconnected', 'revoked'].includes(slack.state)) return 'disconnected';
  if (['reconnect-required', 'permissions-required', 'scope-missing'].includes(slack.state)) return 'attention';
  return 'pending';
}
