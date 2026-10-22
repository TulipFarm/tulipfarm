const userToken = /^Bearer (?:xoxe\.)?xoxp-/;

export function slackUserCall(url, init) {
  const authorization = new Headers(init?.headers).get('authorization') ?? '';
  return userToken.test(authorization) ? new URL(String(url)).pathname.replace(/^\/api\//, '') : null;
}

export function slackUserEffect(method, params) {
  if (method === 'reactions.add')
    return { name: 'react', channel: params.channel, reaction: params.name, ts: params.timestamp };
  if (method !== 'chat.postMessage') return null;
  return params.thread_ts
    ? { name: 'reply', channel: params.channel, text: params.text, ts: params.thread_ts }
    : { name: 'send', channel: params.channel, text: params.text };
}

export async function slackUserRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return {
    method: req.url.replace(/^\/user\//, ''),
    params: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))),
    authorization: req.headers.authorization,
  };
}

export function slackUserRead(method, params, state) {
  if (method === 'conversations.info')
    return {
      ok: true,
      channel: { id: params.channel, name: state.channelName?.(), is_archived: state.archived?.() ?? false },
    };
  if (method === 'conversations.members')
    return { ok: true, members: state.audience(params), response_metadata: { next_cursor: '' } };
  if (method === 'conversations.replies') return { ok: true, messages: state.messages(params), has_more: false };
  if (method === 'conversations.list' || method === 'users.list')
    return { ok: true, ...state.directory(method, params) };
  return null;
}
