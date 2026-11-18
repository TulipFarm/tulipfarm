import { AgentMark } from '@/components/agent-mark';

export function Bud({ size = 40 }: { size?: 24 | 32 | 40 }) {
  return (
    <span className="flex shrink-0">
      <AgentMark size={size} />
    </span>
  );
}
