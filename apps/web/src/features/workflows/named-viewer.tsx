import { useSyncExternalStore, type ComponentProps } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { z } from 'zod';
import type { Definition, providerSourceSchema } from '@tulipfarm/workflows/contracts';
import type { Brand } from '@tulipfarm/sprout/brand-icon';
import { featureReadOptions, useFeatureRead } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { readState } from '@/lib/query/policy';
import { agentApi } from '@/features/agents/api';
import { agentReads } from '@/features/agents/queries';
import { tableApi } from '@/features/tables/api';
import { tableQueries } from '@/features/tables/queries';
import { WorkflowViewer } from './workflow-viewer';
import { workflowQueries } from './queries';
import { workflowSlackDestinationQuery } from './slack-step';
import type { WorkflowLabels } from './diagram-model';

const providerBrands: Record<z.infer<typeof providerSourceSchema>['provider'], Brand> = {
  sheets: 'google-sheets',
  slack: 'slack',
  notion: 'notion',
  gmail: 'gmail',
  forms: 'google-forms',
  jira: 'jira',
  hubspot: 'hubspot',
};
function useWorkflowLabels(workspaceId: string, definition: Definition) {
  const { runtime, scope, current } = useFeatureContext();
  useSyncExternalStore(runtime.subscribeAuthority, runtime.authoritySnapshot, runtime.authoritySnapshot);
  const agentIds = [...new Set(definition.steps.flatMap(step => (step.kind === 'agent' ? [step.agentId] : [])))];
  const tableIds = [
    ...new Set([definition.trigger, ...definition.steps].flatMap(item => ('tableId' in item ? [item.tableId] : []))),
  ];
  const destinationIds = [
    ...new Set(definition.steps.flatMap(step => (step.kind === 'slack-message' ? [step.destinationId] : []))),
  ];
  const integrationId = definition.trigger.kind === 'provider' ? definition.trigger.integrationId : null;
  const agents = useQueries({
    queries: agentIds.map(id =>
      featureReadOptions(runtime, scope, { ...agentReads.detail(agentApi(workspaceId), id), staleTime: 0 }, current),
    ),
  });
  const tables = useQueries({
    queries: tableIds.map(id =>
      featureReadOptions(runtime, scope, { ...tableQueries.detail(tableApi(workspaceId), id), staleTime: 0 }, current),
    ),
  });
  const destinations = useQueries({
    queries: destinationIds.map(id =>
      featureReadOptions(runtime, scope, { ...workflowSlackDestinationQuery(workspaceId, id), staleTime: 0 }, current),
    ),
  });
  const providers = useFeatureRead({
    ...workflowQueries.providers(workspaceId),
    enabled: !!integrationId,
    staleTime: 0,
  });
  const labels: Omit<WorkflowLabels, 'actor'> = { agents: {}, tables: {}, fields: {}, options: {}, destinations: {} };
  const unavailable: string[] = [];
  const states = [...agents, ...tables, ...destinations].map(result => readState<unknown>(result));
  if (integrationId) states.push(providers.state);
  if (current()) {
    agents.forEach((result, index) => {
      const state = readState(result);
      if (state.kind === 'ready' && !state.error) labels.agents![agentIds[index]!] = state.data.name;
      else if (state.kind === 'unavailable') unavailable.push('Agent');
    });
    tables.forEach((result, index) => {
      const state = readState(result);
      if (state.kind === 'ready' && !state.error) {
        const table = state.data.applied?.definition ?? state.data.saved?.definition;
        if (table) {
          labels.tables![tableIds[index]!] = table.label;
          for (const field of table.fields) {
            labels.fields![field.id] = field.label;
            if ('options' in field) for (const option of field.options) labels.options![option.id] = option.label;
          }
        } else unavailable.push('Table');
      } else if (state.kind === 'unavailable') unavailable.push('Table');
    });
    destinations.forEach((result, index) => {
      const state = readState(result);
      if (state.kind === 'ready' && !state.error) labels.destinations![destinationIds[index]!] = `#${state.data.name}`;
      else if (state.kind === 'unavailable') unavailable.push('Slack destination');
    });
    if (integrationId && providers.state.kind === 'ready' && !providers.state.error) {
      const source = providers.state.data.find(
        item => item.id === integrationId && item.enabled && item.authorized && item.capabilities.use,
      );
      if (source) {
        labels.provider = source.name;
        labels.providerBrand = providerBrands[source.source.provider];
      } else unavailable.push('Connected source');
    } else if (integrationId && providers.state.kind === 'unavailable') unavailable.push('Connected source');
  }
  const notice = !current()
    ? 'Connected names are no longer available with your access.'
    : states.some(state => state.kind === 'error' || (state.kind === 'ready' && state.error))
      ? 'Some names could not refresh. Refresh the workflow to check them again.'
      : unavailable.length
        ? `${[...new Set(unavailable)].join(', ')} names are unavailable with your access.`
        : states.some(state => state.kind === 'loading')
          ? 'Loading connected names...'
          : null;
  return {
    labels,
    notice,
    refresh: async () => {
      if (!current()) return;
      await Promise.all([...agents, ...tables, ...destinations].map(read => read.refetch({ cancelRefetch: false })));
      if (integrationId) await providers.refresh();
    },
  };
}

export function NamedWorkflowViewer({
  workspaceId,
  ...props
}: ComponentProps<typeof WorkflowViewer> & { workspaceId: string }) {
  const read = useWorkflowLabels(workspaceId, props.view.definition);
  return (
    <WorkflowViewer
      view={{
        ...props.view,
        labels: { ...props.view.labels, ...read.labels },
        ...(props.view.notice || read.notice
          ? { notice: [props.view.notice, read.notice].filter(Boolean).join(' ') }
          : {}),
      }}
      surface={props.surface ?? 'page'}
      onEdit={props.onEdit}
      onTask={props.onTask}
      stepContent={props.stepContent}
      navigation={props.navigation}
      onRefresh={() => {
        props.onRefresh();
        void read.refresh();
      }}
    />
  );
}
