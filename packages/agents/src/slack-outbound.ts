/** Whether this deployment lets agents act in Slack. It says nothing about whether a workspace has connected Slack. */
export function slackOutboundEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.SLACK_OUTBOUND_ENABLED === 'true';
}
