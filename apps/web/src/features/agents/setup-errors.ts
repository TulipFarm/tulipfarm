const retry = 'Fix it, then retry setup.';
const review = 'Ask chat for a fresh draft or review the setup again.';
const reasons: Record<string, string> = {
  'setup-access-denied': `You no longer have access to something this setup uses. ${retry}`,
  'saved-revision-conflict': `The agent changed after this setup was reviewed. ${review}`,
  'policy-version-conflict': `The agent’s access changed after this setup was reviewed. ${review}`,
  'activation-version-conflict': `Another activation of this agent finished first. ${review}`,
  'activation-scope-exceeds-limits': `The reviewed access is wider than your role allows. ${review}`,
  'slack-channel-setup-unavailable': `Slack could not be set up for this channel. ${retry}`,
  'slack-channel-delivery-unavailable': `The Slack app cannot post in this channel yet. ${retry}`,
  'slack-channel-delivery-disabled': `Slack delivery is turned off for this channel. ${retry}`,
  'slack-attachment-conflict': `Another agent already answers in this Slack channel. ${review}`,
  'github-trigger-unavailable': `The GitHub trigger is unavailable. Check the GitHub connection, then retry setup.`,
  'workflow-github-repository-not-connected': `The trigger’s GitHub repository is not connected. ${retry}`,
  'workflow-sponsor-access-lost': `The trigger’s sponsor no longer has the access it needs. ${retry}`,
  'workflow-sponsor-required': `This trigger needs a sponsor before it can run. ${review}`,
  'task-schedule-interval': `The schedule runs more often than allowed. ${review}`,
  'schedule-invalid': `The schedule is not valid. ${review}`,
  'linked-workflow-changed': `This agent’s workflow changed after review. ${review}`,
  'linked-workflow-archived': `This agent’s workflow was archived. ${review}`,
  'setup-operation-unavailable': 'Setup could not finish because of a temporary problem. Retry setup.',
};

/**
 * Readable text for a stored setup error code. Unknown codes are shown as they are, so the person can report them.
 */
export function setupErrorText(code: string) {
  return reasons[code] ?? `Setup stopped: ${code}. Recheck access and trigger settings, then retry setup.`;
}
