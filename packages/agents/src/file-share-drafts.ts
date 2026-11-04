import { AccessDenied, currentMember, lockAuthorization, type HumanActor } from '@tulipfarm/access';
import { createFiles, FileError, requireFileManager, type FileRole, type SharePreview } from '@tulipfarm/files';
import { AgentError } from './saved-contracts.ts';
import type { DraftOutcome, FileShareProposal } from './draft-contracts.ts';
import { activeMembers, workspaceTeams } from './members.ts';
import { planForDocumentFile, subjectsWithoutPlanSources, type ShareSubject } from './plan-share.ts';
import { agentCompatibility, type AgentStorage, type AgentTransaction } from './store.ts';

const unavailable = () => Promise.reject(new Error('File bytes are not used to share'));
const shown = 100;

export type FileShareRequest = { fileId: string; subjects: ShareSubject[]; role: 'viewer' | 'editor' };
export type PreparedShare =
  | { kind: 'proposal'; input: FileShareProposal['input']; alreadyShared: string[] }
  | { kind: 'nothing'; alreadyShared: string[]; excluded: string[] };

const key = (subject: ShareSubject) => `${subject.kind}:${subject.id}`;
const reaches = (current: FileRole | null, role: FileRole) =>
  current !== null && (current === 'manager' || current === role || (current === 'editor' && role === 'viewer'));

export function createFileShareDrafts(storage: AgentStorage, workspaceId: string) {
  const files = () => createFiles(storage, { putIfAbsent: unavailable, read: unavailable, remove: unavailable });

  async function names(tx: AgentTransaction, subjects: readonly ShareSubject[], audience: readonly string[]) {
    const members = await activeMembers(tx, [
      ...subjects.filter(subject => subject.kind === 'individual').map(subject => subject.id),
      ...audience,
    ]);
    const teams = await workspaceTeams(
      tx,
      subjects.filter(subject => subject.kind === 'team').map(subject => subject.id),
    );
    const byId = new Map<string, string>([
      ...members.map(member => [member.membershipId, member.name] as const),
      ...teams.map(team => [team.teamId, team.name] as const),
    ]);
    return (id: string) => byId.get(id) ?? 'Unnamed member';
  }

  /**
   * Builds the card for sharing one item with people and teams. People and teams who cannot read every source of the
   * plan this file documents are left off; anyone who can already open it at the role needs no grant.
   */
  const read = <T>(actor: HumanActor, operation: (tx: AgentTransaction) => Promise<T>) =>
    storage.transaction(workspaceId, agentCompatibility, async tx => {
      await lockAuthorization(tx, 'read');
      await currentMember(tx, actor);
      return operation(tx);
    });

  async function prepare(actor: HumanActor, request: FileShareRequest): Promise<PreparedShare> {
    const requested = await files().previewShare(
      workspaceId,
      actor.userId,
      request.fileId,
      request.subjects,
      request.role,
    );
    const effective = new Map(requested.before.map(entry => [entry.membershipId, entry.role]));
    const already = requested.subjects.filter(entry =>
      reaches(
        entry.subject.kind === 'individual' ? (effective.get(entry.subject.id) ?? null) : entry.direct,
        request.role,
      ),
    );
    const { planId, excluded, label } = await read(actor, async tx => {
      const planId = await planForDocumentFile(tx, request.fileId);
      const candidates = request.subjects.filter(
        subject => !already.some(entry => key(entry.subject) === key(subject)),
      );
      return {
        planId,
        excluded: planId ? await subjectsWithoutPlanSources(tx, planId, candidates) : [],
        label: await names(tx, request.subjects, []),
      };
    });
    const remaining = request.subjects.filter(
      subject =>
        !already.some(entry => key(entry.subject) === key(subject)) &&
        !excluded.some(other => key(other) === key(subject)),
    );
    const alreadyShared = already.map(entry => label(entry.subject.id));
    if (!remaining.length)
      return { kind: 'nothing', alreadyShared, excluded: excluded.map(subject => label(subject.id)) };
    const preview: SharePreview = await files().previewShare(
      workspaceId,
      actor.userId,
      request.fileId,
      remaining,
      request.role,
    );
    const before = new Set(preview.before.map(entry => entry.membershipId));
    const added = preview.after.filter(entry => !before.has(entry.membershipId)).map(entry => entry.membershipId);
    const audience = await read(actor, tx => names(tx, remaining, [...before, ...added]));
    const side = (ids: string[]) => ({
      names: ids
        .map(audience)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, shown),
      count: ids.length,
    });
    return {
      kind: 'proposal',
      alreadyShared,
      input: {
        file: { id: preview.item.id, name: preview.item.name, kind: preview.item.itemKind },
        planId,
        role: request.role,
        subjects: preview.subjects.map(entry => ({
          kind: entry.subject.kind,
          id: entry.subject.id,
          name: audience(entry.subject.id),
          current: entry.direct,
        })),
        excluded: excluded.map(subject => ({ ...subject, name: label(subject.id) })),
        before: side([...before]),
        added: side(added),
        fingerprint: preview.fingerprint,
      },
    };
  }

  async function writable(tx: AgentTransaction, actor: HumanActor, proposal: FileShareProposal) {
    await requireFileManager(tx, actor, proposal.input.file.id);
  }

  /**
   * Stale once the item's sharing, the people or teams involved, or anyone's access to the plan's sources changed since
   * the card was drafted.
   */
  async function stale(tx: AgentTransaction, actor: HumanActor, proposal: FileShareProposal) {
    const { file, subjects, role, fingerprint, planId } = proposal.input;
    const targets = subjects.map(({ kind, id }) => ({ kind, id }));
    try {
      const preview = await files().previewShare(workspaceId, actor.userId, file.id, targets, role);
      if (preview.fingerprint !== fingerprint) return true;
    } catch (error) {
      if (error instanceof AccessDenied || error instanceof FileError) return true;
      throw error;
    }
    return planId !== null && (await subjectsWithoutPlanSources(tx, planId, targets)).length > 0;
  }

  async function apply(actor: HumanActor, proposal: FileShareProposal): Promise<DraftOutcome> {
    const { file, subjects, role, fingerprint } = proposal.input;
    const targets = subjects.map(({ kind, id }) => ({ kind, id }));
    try {
      await files().shareReviewed(workspaceId, actor.userId, file.id, targets, role, fingerprint);
    } catch (error) {
      if (error instanceof FileError && error.code === 'conflict') throw new AgentError('draft-stale');
      throw error;
    }
    return { kind: 'file-share', fileId: file.id, role, subjects: targets };
  }

  return { prepare, writable, stale, apply };
}
