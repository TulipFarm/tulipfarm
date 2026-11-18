const sizes = {
  24: 'size-6 p-1',
  32: 'size-8 p-1.5',
  40: 'size-10 p-2',
} as const;

/** The one still image every agent, Bud included, shows: the TulipFarm tulip in a circle. */
export function AgentMark({ size = 32 }: { size?: keyof typeof sizes }) {
  return (
    <span
      data-slot="agent-mark"
      aria-hidden="true"
      className={`inline-flex shrink-0 rounded-full bg-muted ${sizes[size]}`}
    >
      <img src="/favicon.svg" alt="" className="size-full" />
    </span>
  );
}
