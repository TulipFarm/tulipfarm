import { manualWorkspaceMemberValues, workspaceMemberFields } from '@tulipfarm/tables/workspace-members';
import { tableApi, workspaceMembersApi, type TableDataRow, type TableDefinition } from './api';

type MemberRequest = { email: string; memberRequestId: string; memberRecordId: string };

/** "jessica.smith+ops@example.com" becomes "Jessica Smith Ops". */
export function memberNameFromEmail(email: string) {
  const words = (email.split('@')[0] ?? '').split(/[._+-]+/).filter(Boolean);
  return words.length ? words.map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ') : email;
}

function emailOf(row: TableDataRow, field: string) {
  const value = row.values[field];
  return value?.kind === 'text' && typeof value.value === 'string' ? value.value.trim().toLowerCase() : null;
}

function isActive(row: TableDataRow) {
  const value = row.values[workspaceMemberFields.active];
  return !(value?.kind === 'boolean' && value.value === false);
}

/**
 * Finds the Workspace members row for an email, or creates one, so every
 * invitation links a member without asking the inviter to pick it. One
 * resolver serves one batch and loads the members table once.
 */
export function invitationMemberResolver(workspaceId: string) {
  const members = workspaceMembersApi(workspaceId);
  const rows = tableApi(workspaceId);
  let table: Promise<Pick<TableDefinition, 'id' | 'revision'>> | undefined;
  const created = new Set<string>();
  function load() {
    table ??= members.state({}, AbortSignal.timeout(15_000)).then(
      state => ({ id: state.tableId, revision: state.revision }),
      error => {
        table = undefined;
        throw error;
      },
    );
    return table;
  }
  return {
    created,
    async resolve(request: MemberRequest) {
      const current = await load();
      const email = request.email.toLowerCase();
      const page = await rows.recordPage(current, { search: request.email }, undefined, AbortSignal.timeout(15_000));
      const matches = page.records.filter(row =>
        [workspaceMemberFields.accountEmail, workspaceMemberFields.contactEmail].some(
          field => emailOf(row, field) === email,
        ),
      );
      const match =
        matches.find(row => emailOf(row, workspaceMemberFields.accountEmail) === email) ??
        matches.find(isActive) ??
        matches[0];
      if (match) return match.id;
      const row = await rows.mutate({
        kind: 'create',
        requestId: request.memberRequestId,
        tableId: current.id,
        revision: current.revision,
        recordId: request.memberRecordId,
        values: manualWorkspaceMemberValues({ name: memberNameFromEmail(request.email), contactEmail: request.email }),
      });
      created.add(current.id);
      return row.id;
    },
  };
}
