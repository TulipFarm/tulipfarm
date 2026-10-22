import { AgentAvatar as SproutAgentAvatar, type AgentAvatarProps } from '@tulipfarm/sprout/avatar';
import { agentAvatar } from '@/lib/agent-avatar';

/** Sprout's AgentAvatar loads hosted artwork by default; this reads the configured origin instead. */
export function AgentAvatar(props: AgentAvatarProps) {
  return <SproutAgentAvatar {...props} src={props.src ?? agentAvatar(props.agentId).src} />;
}
