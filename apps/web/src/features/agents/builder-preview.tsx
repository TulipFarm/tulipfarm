import type { ReactNode } from 'react';
import { CalendarClock, MessageSquare, ScrollText, ShieldCheck, Wrench } from 'lucide-react';
import { AgentAvatar } from '@tulipfarm/sprout/agent-avatar';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';
import { Disclosure } from '@/components/disclosure';
import { toolLabels } from './labels';
import type { ToolName } from './tool-picker';
import type { SkillSelections } from './skill-picker';
import type { BuilderStep } from './builder-layout';

export function AgentDraftSummary({
  name,
  instructions,
  team,
  model,
  skills,
  tools,
  channelNames,
  scheduleLabels,
  onEdit,
}: {
  name: string;
  instructions: string;
  team: string | undefined;
  model: ReactNode;
  skills: SkillSelections;
  tools: readonly ToolName[];
  channelNames: readonly string[];
  scheduleLabels: readonly string[];
  onEdit?: ((step: BuilderStep) => void) | undefined;
}) {
  return (
    <div className="grid min-w-0 gap-5">
      <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-foreground-secondary">
        {instructions.trim()
          ? instructions.slice(0, 260) + (instructions.length > 260 ? '…' : '')
          : 'Add instructions to shape how your agent speaks, works, and asks for help.'}
      </p>
      <div className="grid gap-2 text-sm">
        <span className="text-muted-foreground">Preferred model</span>
        <div className="min-w-0 text-foreground">{model}</div>
      </div>
      <dl className="grid gap-4 text-sm">
        {(
          [
            {
              step: 'skills',
              Icon: ScrollText,
              term: 'Skills',
              value: skills.length
                ? `${skills.length} procedure${skills.length === 1 ? '' : 's'}`
                : 'No skills selected',
            },
            {
              step: 'access',
              Icon: Wrench,
              term: 'Actions',
              value: tools.length
                ? `${tools.length} permitted action${tools.length === 1 ? '' : 's'}`
                : 'No actions selected',
            },
            { step: 'basics', Icon: ShieldCheck, term: 'Team placement', value: team ?? 'Personal agent' },
            {
              step: 'triggers',
              Icon: MessageSquare,
              term: 'Slack',
              value: channelNames.length
                ? channelNames.map(channel => (channel.startsWith('#') ? channel : `#${channel}`)).join(', ')
                : 'Not attached',
            },
            {
              step: 'triggers',
              Icon: CalendarClock,
              term: 'Schedules',
              value: scheduleLabels.length
                ? `${scheduleLabels.length} scheduled task${scheduleLabels.length === 1 ? '' : 's'}`
                : 'Manual use only',
            },
          ] as const
        ).map(({ step, Icon, term, value }) => (
          <div key={term} className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 shrink-0 text-muted-foreground">
              <Icon aria-hidden="true" size={16} />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="wrap-anywhere text-foreground">{value}</dd>
            </div>
            {onEdit && (
              <Button variant="ghost" size="sm" aria-label={`Edit ${term.toLowerCase()}`} onClick={() => onEdit(step)}>
                Edit
              </Button>
            )}
          </div>
        ))}
      </dl>
      <Disclosure title="Details">
        <div className="grid min-w-0 gap-3 text-sm">
          <p className="wrap-anywhere">{name.trim() || 'Untitled agent'}</p>
          <p className="whitespace-pre-wrap wrap-anywhere">{instructions || 'No instructions yet.'}</p>
          {tools.length > 0 && (
            <ul aria-label="Selected actions" className="flex flex-wrap gap-1.5">
              {tools.map(tool => (
                <li key={tool}>
                  <Badge variant="outline">{toolLabels[tool]}</Badge>
                </li>
              ))}
            </ul>
          )}
          {skills.length > 0 && (
            <ul aria-label="Selected skill versions" className="grid gap-1">
              {skills.map(skill => (
                <li key={skill.id} className="break-all text-xs">
                  {skill.id}: {skill.revision}
                </li>
              ))}
            </ul>
          )}
          {scheduleLabels.length > 0 && (
            <ul className="grid gap-1">
              {scheduleLabels.map((label, index) => (
                <li key={index} className="wrap-anywhere">
                  {label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Disclosure>
    </div>
  );
}

export function AgentBuilderPreview({
  agentId,
  name,
  team,
  tab,
  onTab,
  summary,
  children,
}: {
  agentId: string;
  name: string;
  team: string | undefined;
  tab: 'summary' | 'test';
  onTab: (tab: 'summary' | 'test') => void;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label="Draft agent" className="grid min-w-0 gap-5 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <AgentAvatar agentId={agentId} name={name.trim() || 'New agent'} size="lg" />
        <div className="grid min-w-0 flex-1 gap-1">
          <h2 className="wrap-anywhere text-base font-medium text-foreground">{name.trim() || 'Your new agent'}</h2>
          <p className="text-sm text-muted-foreground">{team ?? 'Personal agent'}</p>
        </div>
        <Badge variant="secondary">Draft</Badge>
      </div>
      <Tabs
        value={tab}
        onValueChange={value => {
          if (value === 'summary' || value === 'test') onTab(value);
        }}
      >
        <TabsList variant="line" aria-label="Agent views">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="test">Test chat</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" keepMounted>
          <div className="pt-4">{summary}</div>
        </TabsContent>
        <TabsContent value="test" keepMounted>
          <div className="pt-4">{children}</div>
        </TabsContent>
      </Tabs>
      <p className="border-t pt-3 text-xs text-muted-foreground">Nothing runs until you review and activate.</p>
    </section>
  );
}
