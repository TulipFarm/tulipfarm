import type { Chat } from './conversation-api';

/** A chat change shown before the server confirms it. */
export type ChatEdit =
  | { kind: 'rename'; title: string }
  | { kind: 'archive'; archived: boolean }
  | { kind: 'delete' }
  | { kind: 'pin'; pinned: boolean };

export function editChat(chat: Chat, edit: ChatEdit): Chat {
  if (edit.kind === 'rename')
    return { ...chat, title: edit.title, titleRevision: chat.titleRevision + 1, titleManual: true };
  if (edit.kind === 'archive') return { ...chat, archived: edit.archived };
  if (edit.kind === 'pin') return { ...chat, pinned: edit.pinned };
  return chat;
}

/** Applies `edit` to a cached chat read: a paged list (`{ chats }`) or the pinned chats. */
export function editList(data: unknown, key: readonly unknown[], chat: Chat, edit: ChatEdit) {
  if (key[2] === 'pinned') return Array.isArray(data) ? editPinned(data as Chat[], chat, edit) : data;
  if (!data || typeof data !== 'object' || !('chats' in data) || !Array.isArray(data.chats)) return data;
  const chats = data.chats as Chat[];
  if (!chats.some(item => item.id === chat.id)) return data;
  const leaves =
    edit.kind === 'delete' ||
    (edit.kind === 'archive' && chats.some(item => item.id === chat.id && item.archived !== edit.archived));
  if (leaves) return { ...data, chats: chats.filter(item => item.id !== chat.id) };
  return { ...data, chats: chats.map(item => (item.id === chat.id ? editChat(item, edit) : item)) };
}

function editPinned(chats: Chat[], chat: Chat, edit: ChatEdit) {
  const listed = chats.some(item => item.id === chat.id);
  const leaves =
    edit.kind === 'delete' || (edit.kind === 'pin' && !edit.pinned) || (edit.kind === 'archive' && edit.archived);
  if (leaves) return listed ? chats.filter(item => item.id !== chat.id) : chats;
  if (edit.kind === 'pin' && !listed && !chat.archived) return [editChat(chat, edit), ...chats];
  return listed ? chats.map(item => (item.id === chat.id ? editChat(item, edit) : item)) : chats;
}
