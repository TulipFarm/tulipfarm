import type { InformationRequest } from '@/features/chat/interaction-contracts';
import type { TaskSecretRequest } from './contracts';
import { useTaskSecretRequests } from './queries';
import { SecretRequestCard } from './request-card';

const statuses = {
  waiting: 'pending',
  provided: 'answered',
  declined: 'answered',
  expired: 'expired',
  cancelled: 'cancelled',
} as const;

export function taskInformationRequest(taskId: string, request: TaskSecretRequest): InformationRequest {
  return {
    id: request.id,
    turnId: taskId,
    revision: request.revision,
    prompt: request.purpose,
    expiresAt: request.expiresAt,
    answerSchema: { kind: 'secrets', secretRequestId: request.id },
    status: statuses[request.status],
    response:
      request.status === 'provided' || request.status === 'declined'
        ? {
            id: request.id,
            answer: {
              kind: 'secrets',
              status: request.status,
              references: request.references,
              reason: request.declineReason,
            },
            createdAt: request.expiresAt,
          }
        : null,
  };
}

/** The secret forms a task sent its owner. The API returns none to anyone else. */
export function TaskSecretRequests({
  workspaceId,
  taskId,
  revision,
  onSettled,
}: {
  workspaceId: string;
  taskId: string;
  revision: string;
  onSettled: () => Promise<void>;
}) {
  const read = useTaskSecretRequests(workspaceId, taskId, revision);
  if (read.state.kind !== 'ready' || read.state.data.length === 0) return null;
  const settled = async () => {
    await Promise.all([read.refresh(), onSettled()]);
  };
  return (
    <div className="space-y-2">
      {read.state.data.map(request => (
        <SecretRequestCard key={request.id} request={taskInformationRequest(taskId, request)} onSettled={settled} />
      ))}
    </div>
  );
}
