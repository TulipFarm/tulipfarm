import type { RecentItem } from '../navigation/recent-queries';
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

export function editList(data: unknown, key: readonly unknown[], chat: Chat, edit: ChatEdit) {
  if (Array.isArray(data)) return editSidebar(data as RecentItem[], chat, edit);
  if (!data || typeof data !== 'object' || !('chats' in data) || !Array.isArray(data.chats)) return data;
  const chats = data.chats as Chat[];
  const pinnedList = key[2] === 'pinned';
  const leaves =
    edit.kind === 'delete' ||
    (edit.kind === 'archive' && chats.some(item => item.id === chat.id && item.archived !== edit.archived)) ||
    (pinnedList && ((edit.kind === 'pin' && !edit.pinned) || (edit.kind === 'archive' && edit.archived)));
  if (leaves) return { ...data, chats: chats.filter(item => item.id !== chat.id) };
  if (pinnedList && edit.kind === 'pin' && !chat.archived && !chats.some(item => item.id === chat.id))
    return { ...data, chats: [editChat(chat, edit), ...chats] };
  if (!chats.some(item => item.id === chat.id)) return data;
  return { ...data, chats: chats.map(item => (item.id === chat.id ? editChat(item, edit) : item)) };
}

function editSidebar(items: RecentItem[], chat: Chat, edit: ChatEdit) {
  const others = items.filter(item => item.id !== chat.id);
  const current = items.find(item => item.id === chat.id);
  if (edit.kind === 'delete' || (edit.kind === 'archive' && edit.archived)) return current ? others : items;
  if (edit.kind === 'rename')
    return current ? items.map(item => (item.id === chat.id ? { ...item, name: edit.title } : item)) : items;
  if (edit.kind === 'pin' && edit.pinned && !chat.archived)
    return [{ id: chat.id, name: current?.name ?? chat.title, pinned: true }, ...others];
  if (edit.kind === 'pin' && current)
    return items.map(item => (item.id === chat.id ? { ...item, pinned: false } : item));
  return items;
}
