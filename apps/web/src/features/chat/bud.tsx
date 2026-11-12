import { MonsterAvatar } from '@tulipfarm/sprout/monster-avatar';

export function Bud({ size = 40 }: { size?: number }) {
  return (
    <span className="flex shrink-0">
      <MonsterAvatar agentId="bud" size={size} />
    </span>
  );
}
