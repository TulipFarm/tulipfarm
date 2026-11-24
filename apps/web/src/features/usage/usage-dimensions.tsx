import type { ComponentType, ReactNode } from 'react';
import { CpuIcon, KeyIcon, RepeatIcon, UserIcon, UsersIcon, WalletIcon } from '@tulipfarm/icons';
import type { ModelFallbackReason } from '@tulipfarm/config/model-fallback';
import type { UsageDimension, UsageReport } from '@tulipfarm/workspace-storage/model-usage-contracts';
import { AgentAvatar } from '@tulipfarm/sprout/agent-avatar';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import { modelBrand, planModelVendor } from '@/features/models/model-brand';
import { planLabels } from '@/features/chat/reply-failure-copy';
import { dateOf } from './usage-model.ts';

export type Member = { id: string; name: string; image: string | null };
export type DimensionInfo = {
  label: string;
  name: (value: string) => string;
  icon?: (value: string) => ReactNode;
};

const providers: Record<string, { name: string; brand?: Brand }> = {
  anthropic: { name: 'Anthropic', brand: 'claude' },
  openai: { name: 'OpenAI', brand: 'openai' },
  xai: { name: 'xAI', brand: 'grok' },
  google: { name: 'Google', brand: 'gemini' },
  azure: { name: 'Microsoft Azure' },
  'openai-compatible': { name: 'OpenAI-compatible' },
  chatgpt: { name: 'ChatGPT plan', brand: 'openai' },
  claude: { name: 'Claude plan', brand: 'claude' },
  copilot: { name: 'GitHub Copilot plan', brand: 'github' },
  unknown: { name: 'Unknown' },
};
const planBrands: Record<keyof typeof planLabels, Brand> = { chatgpt: 'openai', claude: 'claude', copilot: 'github' };

export const paidByLabels: Record<string, string> = {
  credits: 'TulipFarm credits',
  plan: 'Member plan',
  key: 'API key',
};

const activities: Record<string, string> = {
  chat: 'Chat',
  agent: 'Agent run',
  task: 'Agent task',
  scheduled: 'Scheduled run',
  'table-search': 'Table search',
  'app-build': 'App build',
  'app-hosting': 'App hosting',
  storage: 'Storage',
  compute: 'Compute',
  other: 'Other',
};
// Storage and compute charges name what they measured in place of a model.
const resourceModels: Record<string, string> = {
  'storage-database': 'Database storage',
  'storage-objects': 'File storage',
  'storage-apps': 'Published app storage',
  'compute-sandbox': 'Sandboxes',
  'compute-runs': 'Agent and workflow runs',
  'compute-browser': 'Browser sessions',
};
const activityName = (value: string) =>
  activities[value] ?? (value.startsWith('knowledge-') ? `Knowledge (${value.slice(10).replaceAll('-', ' ')})` : value);

const fallbackReasons: Record<ModelFallbackReason | 'unknown', string> = {
  quota: 'limit reached',
  'rate-limit': 'rate limited',
  outage: 'provider outage',
  timeout: 'timed out',
  'model-unavailable': 'model unavailable',
  'sign-in': 'sign-in needed',
  unknown: 'could not answer',
};

const shortDate = (day: string) => dateOf(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function glyph(Icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>, tone = 'text-muted-foreground') {
  return (
    <span className={`inline-flex shrink-0 ${tone}`}>
      <Icon size={14} aria-hidden />
    </span>
  );
}

/** Names and icons for every group value in a report, from its labels and the workspace's members. */
export function usageDimensions(report: UsageReport, members: ReadonlyMap<string, Member>) {
  const memberName = (id: string) => {
    if (id === 'others') return 'Other members';
    if (id === 'workspace') return 'Workspace (no member)';
    const name = members.get(id)?.name ?? 'Former member';
    return id === report.viewer.membershipId ? `${name} (you)` : name;
  };
  const memberIcon = (id: string) => {
    const member = members.get(id);
    if (id === 'others') return glyph(UsersIcon);
    if (!member) return glyph(UserIcon);
    return <EntityAvatar seed={member.id} name={member.name} image={member.image} size="sm" />;
  };
  const agentName = (id: string) => (id === 'none' ? 'No agent' : (report.labels.agents[id] ?? 'Agent'));
  const connectionName = (id: string) => {
    if (id === 'credits') return paidByLabels.credits!;
    if (id === 'key') return 'API key';
    if (id === 'plan') return 'Member plan';
    const connection = report.labels.connections[id];
    if (!connection) return 'Member plan';
    const plan = `${planLabels[connection.provider]} plan`;
    if (connection.ownerMembershipId === report.viewer.membershipId) return `Your ${plan}`;
    const owner = members.get(connection.ownerMembershipId)?.name;
    return owner ? `${owner}’s ${plan}` : plan;
  };
  const connectionIcon = (id: string) => {
    const connection = report.labels.connections[id];
    if (connection) return <BrandIcon brand={planBrands[connection.provider]} size="inline" />;
    if (id === 'key') return glyph(KeyIcon);
    if (id === 'credits') return glyph(WalletIcon);
    return glyph(UserIcon);
  };
  const modelIcon = (id: string) => {
    const label = report.labels.models[id];
    const brand = modelBrand(label?.vendor ?? planModelVendor(id.split('/').at(-1) ?? id));
    return brand ? <BrandIcon brand={brand} size="inline" /> : glyph(CpuIcon);
  };
  const dimensions: Record<UsageDimension, DimensionInfo> = {
    model: {
      label: 'Model',
      name: id => report.labels.models[id]?.name ?? resourceModels[id] ?? (id === 'unknown' ? 'Unknown model' : id),
      icon: modelIcon,
    },
    provider: {
      label: 'Model provider',
      name: value => providers[value]?.name ?? value,
      icon: value => {
        const brand = providers[value]?.brand;
        return brand ? <BrandIcon brand={brand} size="inline" /> : glyph(CpuIcon);
      },
    },
    paidBy: {
      label: 'Paid by',
      name: value => paidByLabels[value] ?? value,
      icon: value => (value === 'credits' ? glyph(WalletIcon) : value === 'key' ? glyph(KeyIcon) : glyph(UserIcon)),
    },
    connection: { label: 'Plan or key', name: connectionName, icon: connectionIcon },
    usedBy: {
      label: 'Person or agent',
      name: value => {
        const [kind, id = ''] = value.split(/:(.*)/s);
        return kind === 'agent' ? agentName(id) : memberName(id);
      },
      icon: value => {
        const [kind, id = ''] = value.split(/:(.*)/s);
        return kind === 'agent' ? <AgentAvatar agentId={id} name={agentName(id)} size="sm" /> : memberIcon(id);
      },
    },
    member: { label: 'Member', name: memberName, icon: memberIcon },
    agent: {
      label: 'Agent',
      name: agentName,
      icon: value => (value === 'none' ? null : <AgentAvatar agentId={value} name={agentName(value)} size="sm" />),
    },
    activity: { label: 'Activity', name: activityName },
    fallback: {
      label: 'Fallback',
      name: value => {
        if (value === 'none') return 'Answered as chosen';
        const [reason = 'unknown', from = ''] = value.split('|');
        const why = fallbackReasons[reason as ModelFallbackReason] ?? fallbackReasons.unknown;
        return from ? `${connectionName(from)}: ${why}` : `Fell back: ${why}`;
      },
      icon: value => (value === 'none' ? null : glyph(RepeatIcon, 'text-warning')),
    },
    week: { label: 'Week', name: value => `Week of ${shortDate(value)}` },
    day: { label: 'Day', name: shortDate },
  };
  return dimensions;
}
export type UsageDimensions = ReturnType<typeof usageDimensions>;
