const review = 'Review the setup again, then activate it.';
const reasons: Record<string, string> = {
  'setup-access-denied': 'You no longer have access to something this setup uses. Get access back, then retry setup.',
  'saved-revision-conflict': `A newer version of this agent was saved after this setup was reviewed. ${review}`,
  'policy-version-conflict': `This agent’s placement or sharing changed after this setup was reviewed. ${review}`,
  'activation-version-conflict': `This agent’s active setup changed after this setup was reviewed. ${review}`,
  'activation-scope-exceeds-limits': `This setup asks for more data access than the agent’s limits allow. ${review}`,
  'slack-channel-setup-unavailable': 'Slack channel setup isn’t available right now. Retry setup later.',
  'slack-channel-delivery-unavailable': 'The Slack app can’t post in this channel yet. Retry setup later.',
  'slack-channel-delivery-disabled':
    'Agent replies in Slack channels are turned off. Remove the channel from this setup, then activate it.',
  'slack-attachment-conflict': `This Slack channel’s agent changed after this setup was reviewed. ${review}`,
  'github-trigger-unavailable': 'GitHub triggers aren’t available right now. Retry setup later.',
  'workflow-github-repository-not-connected':
    'The trigger’s GitHub repository isn’t connected. Connect it, then retry setup.',
  'workflow-sponsor-access-lost':
    'The trigger’s sponsor no longer has the access it needs. Restore that access, then retry setup.',
  'workflow-sponsor-required': `This trigger needs a sponsor before it can run. ${review}`,
  'task-schedule-interval': `Schedules can run at most once an hour. ${review}`,
  'schedule-invalid': `The schedule is not valid. ${review}`,
  'linked-workflow-changed': `This agent’s workflow changed after review. ${review}`,
  'linked-workflow-archived': `This agent’s workflow was archived. ${review}`,
  'setup-operation-unavailable': 'Setup could not finish because of an unexpected problem. Retry setup.',
  'definition-failed': 'The agent could not be saved. Nothing was changed.',
  'definition-conflict': `This agent changed before it could be saved. ${review}`,
};

// Something changed after review, so retrying the same reviewed setup fails the same way.
const reviewAgain = new Set([
  'saved-revision-conflict',
  'policy-version-conflict',
  'activation-version-conflict',
  'activation-scope-exceeds-limits',
  'slack-attachment-conflict',
  'definition-conflict',
]);

/** Readable text for a stored setup error code. Unknown codes are shown as they are, so the person can report them. */
export function setupErrorText(code: string) {
  return (
    reasons[code] ??
    `Setup could not finish (error: ${code}). Retry setup. If it happens again, share this code when you ask for help.`
  );
}

/** Whether retrying the same reviewed setup can succeed. */
export function setupRetryable(code: string | null) {
  return !code || !reviewAgain.has(code);
}
