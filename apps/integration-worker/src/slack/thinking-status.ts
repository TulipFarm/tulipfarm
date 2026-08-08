/**
 * Status text for the Agents & AI Apps status indicator (`assistant.threads.setStatus`) while a
 * Channel-originated Run is in flight. Slack renders its own animated gradient for motion, so
 * unlike the old `chat.update` text-rotation hack this needs only one static string.
 */
export const THINKING_STATUS = "is thinking…";
