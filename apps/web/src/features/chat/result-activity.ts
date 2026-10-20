import type { ToolPresentation } from '@tulipfarm/conversations/tool-activity';
import type { ToolActivityStatus } from '@tulipfarm/sprout/tool-activity';
import type { ResultApp, ResultAppAction } from '@tulipfarm/sprout/result-card';
import { brandNames } from '@tulipfarm/sprout/brand-icon';

export type ResultActivity = {
  id: string;
  tool: string;
  status: ToolActivityStatus;
  presentation: ToolPresentation;
  detail?: string | undefined;
};

export function activityActionState(status: ToolActivityStatus): ResultAppAction['state'] {
  return status === 'queued' || status === 'waiting' ? 'pending' : status;
}

export function resultActivityApps(items: readonly ResultActivity[]): ResultApp[] {
  const apps = new Map<string, ResultApp>();
  for (const item of items) {
    const brand = item.presentation.brand;
    if (!brand && !/^(mcp|atlassian)\./.test(item.tool)) continue;
    const name = brand ? brandNames[brand] : item.tool.startsWith('atlassian.') ? 'Atlassian' : 'Connected apps';
    const app = apps.get(name);
    const action = { label: item.presentation.label, state: activityActionState(item.status) };
    apps.set(name, { brand, name, actions: [...(app?.actions ?? []), action] });
  }
  return [...apps.values()];
}
