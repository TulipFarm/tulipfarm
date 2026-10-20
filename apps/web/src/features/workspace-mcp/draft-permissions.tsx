import { ChoiceGroup } from '@tulipfarm/sprout/field';
import { useFeatureRead } from '@/lib/query';
import { McpGate, McpRead } from './state';
import type { McpApi } from './api';
import type { PermissionSlot } from './contracts';

export function McpDraftPermissions({
  workspaceId,
  value,
  onChange,
  disabled,
}: {
  workspaceId: string;
  value: PermissionSlot[];
  onChange: (value: PermissionSlot[]) => void;
  disabled: boolean;
}) {
  return (
    <McpGate workspaceId={workspaceId}>
      {api => <Choices api={api} value={value} onChange={onChange} disabled={disabled} />}
    </McpGate>
  );
}

function Choices({
  api,
  value,
  onChange,
  disabled,
}: {
  api: McpApi;
  value: PermissionSlot[];
  onChange: (value: PermissionSlot[]) => void;
  disabled: boolean;
}) {
  const read = useFeatureRead({
    key: ['workspace-mcp', 'agent-permission-choices'],
    load: (signal: AbortSignal) => api.permissionChoices(signal),
  });
  return (
    <McpRead state={read.state} refresh={read.refresh} label="Reviewed MCP tools">
      {(choices, blocked) => (
        <div className="grid gap-4">
          {!choices.length && (
            <p className="text-sm text-muted-foreground">
              No reviewed MCP tools are available. Review a server in Integrations first. Private, unreviewed servers
              stay chat-only.
            </p>
          )}
          {choices.map(choice => {
            const selected = value.find(slot => slot.slotId === choice.slotId);
            return (
              <ChoiceGroup
                key={choice.slotId}
                type="checkbox"
                optional
                disabled={disabled || blocked}
                legend={choice.label}
                helper={
                  choice.binding.kind === 'shared'
                    ? 'Uses this shared integration. Its permissions still apply.'
                    : 'Each caller must bind their own account. Your personal integration is not shared.'
                }
                options={choice.tools.map(tool => ({ value: JSON.stringify(tool), label: tool.name }))}
                value={(selected?.tools ?? []).map(tool => JSON.stringify(tool))}
                onValueChange={next => {
                  const tools = choice.tools.filter(tool => next.includes(JSON.stringify(tool)));
                  onChange([
                    ...value.filter(slot => slot.slotId !== choice.slotId),
                    ...(tools.length ? [{ ...choice, tools }] : []),
                  ]);
                }}
              />
            );
          })}
          {value.some(slot => !choices.some(choice => choice.slotId === slot.slotId)) && (
            <p role="alert" className="text-sm text-destructive">
              A selected MCP server is no longer available. Remove its permission before activating.
            </p>
          )}
          {value
            .filter(slot => !choices.some(choice => choice.slotId === slot.slotId))
            .map(slot => (
              <ChoiceGroup
                key={slot.slotId}
                type="checkbox"
                optional
                disabled={disabled}
                legend={slot.label}
                options={slot.tools.map(tool => ({ value: JSON.stringify(tool), label: `${tool.name} (unavailable)` }))}
                value={slot.tools.map(tool => JSON.stringify(tool))}
                onValueChange={next =>
                  onChange(
                    value.flatMap(item =>
                      item.slotId !== slot.slotId
                        ? [item]
                        : next.length
                          ? [{ ...item, tools: item.tools.filter(tool => next.includes(JSON.stringify(tool))) }]
                          : [],
                    ),
                  )
                }
              />
            ))}
        </div>
      )}
    </McpRead>
  );
}
