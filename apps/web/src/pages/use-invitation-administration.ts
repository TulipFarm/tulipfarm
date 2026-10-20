import { useRef, useState } from 'react';
import { useInvitations, type Invitation } from '@/features/governance/invitations';

export type { Invitation } from '@/features/governance/invitations';
export type InvitationAdministration = ReturnType<typeof useInvitationAdministration>;

export function useInvitationAdministration(workspaceId: string, authorized: boolean, onAccessLost: () => void) {
  const [search, setSearch] = useState('');
  // Keep invitation receipts independent of the list filter so dialog recovery retains its actions.
  const read = useInvitations(workspaceId, authorized, onAccessLost);
  const filtered = useInvitations(workspaceId, authorized && !!search.trim(), onAccessLost, search);
  const list = search.trim() ? filtered : read;
  const [actions, setActions] = useState(new Set<string>());
  const pending = useRef(new Set<string>());
  const resends = useRef(new Map<string, { requestId: string; workspaceMemberId: string | null }>());
  const successors = useRef(new Map<string, string>());
  function record(item: Invitation, predecessor?: Invitation) {
    if (predecessor && predecessor.id !== item.id) successors.current.set(predecessor.id, item.id);
    read.record(item, predecessor);
  }
  function begin(id: string) {
    if (!authorized || pending.current.has(id)) return false;
    pending.current.add(id);
    setActions(new Set(pending.current));
    return true;
  }
  function finish(id: string) {
    pending.current.delete(id);
    setActions(new Set(pending.current));
  }
  function resendRequest(id: string, workspaceMemberId: string | null = null) {
    const existing = resends.current.get(id);
    if (existing && existing.workspaceMemberId !== workspaceMemberId)
      throw new Error('Keep the same member while retrying this resend.');
    const intent = existing ?? { requestId: crypto.randomUUID(), workspaceMemberId };
    resends.current.set(id, intent);
    return intent.requestId;
  }
  function resolve(id: string): Invitation | undefined {
    let current = id;
    while (successors.current.has(current)) {
      const next = successors.current.get(current);
      if (!next) break;
      current = next;
    }
    return read.data?.items.find(item => item.id === current);
  }
  return {
    data: list.data,
    error: list.error,
    busy: list.busy,
    refresh: list.refresh,
    search,
    setSearch,
    record,
    resolve,
    begin,
    finish,
    actionBusy: (id: string) => actions.has(id),
    resendPending: (id: string) => resends.current.has(id),
    resendMember: (id: string) => resends.current.get(id)?.workspaceMemberId ?? null,
    resendRequest,
    resendRejected: (id: string) => {
      resends.current.delete(id);
    },
    resendConfirmed: (id: string) => {
      resends.current.delete(id);
    },
  };
}
