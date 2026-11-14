/** Sent through the `analytics` web slot each time a chat message ends up not sent. */
export const chatSendFailedEvent = 'chat_send_failed';

export type ChatSendFailedProperties = {
  /**
   * `rejected`: the API refused the message. `unsent`: the API confirmed it never stored it. `offline`: the browser had
   * no network. `updating`: the workspace was still updating when retries ran out. `uncertain`: no answer, so whether
   * it was stored is unknown.
   */
  reason: 'rejected' | 'unsent' | 'offline' | 'updating' | 'uncertain';
  /** The API status, when it answered with an error. */
  status?: number;
  /** The API's short error code, when it sent one. */
  code?: string;
};

/** The command states that leave a message not sent. */
export type NotSentState =
  | { kind: 'uncertain'; offline: boolean; updating?: boolean; unsent?: boolean }
  | { kind: 'rejected'; status: number };

// Codes are short machine identifiers such as `workspace-updating`; anything else could be text and is dropped.
const errorCode = /^[a-z][a-z0-9_.-]{0,63}$/;

function errorStatus(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

/** Classifies a send that ended not sent, without the message, its chat or any error text. */
export function chatSendFailureProperties(state: NotSentState, error?: unknown): ChatSendFailedProperties {
  const reason =
    state.kind === 'rejected'
      ? 'rejected'
      : state.offline
        ? 'offline'
        : state.unsent
          ? 'unsent'
          : state.updating
            ? 'updating'
            : 'uncertain';
  const status = errorStatus(error) ?? (state.kind === 'rejected' ? errorStatus({ status: state.status }) : undefined);
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return {
    reason,
    ...(status !== undefined && { status }),
    ...(typeof code === 'string' && errorCode.test(code) && { code }),
  };
}
