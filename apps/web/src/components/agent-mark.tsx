import { hash } from '@/lib/hash';

const sizes = {
  24: 'size-6 p-1',
  32: 'size-8 p-1.5',
  40: 'size-10 p-2',
} as const;

// Styled in app.css.
const colors = ['indigo', 'cyan', 'blue', 'purple', 'red', 'orange', 'yellow'] as const;

/** The TulipFarm tulip in a circle, in a color picked from `agentId`. Without one (Bud), it is indigo. */
export function AgentMark({ agentId, size = 32 }: { agentId?: string | undefined; size?: keyof typeof sizes }) {
  const color = agentId ? colors[hash(agentId) % colors.length] : colors[0];
  return (
    <span
      data-slot="agent-mark"
      data-color={color}
      aria-hidden="true"
      className={`inline-flex shrink-0 rounded-full ${sizes[size]}`}
    >
      <span className="size-full" />
    </span>
  );
}
