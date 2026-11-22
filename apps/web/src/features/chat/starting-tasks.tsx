import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  BookIcon,
  CalendarSearchIcon,
  ClockIcon,
  DatabaseIcon,
  MessageEditIcon,
  NoteIcon,
  PlugIcon,
  RepeatIcon,
  TasksIcon,
  UserAddIcon,
} from '@tulipfarm/icons';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { BrandStack, type Brand } from '@tulipfarm/sprout/brand-icon';
import { SuggestionCard, SuggestionGrid, type SuggestionTone } from '@/components/chat-suggestions';
import { workspaceRoute } from '@/router';
import { fillTasks, prioritizeTasks } from './starting-task-priority';
import { fallbackRecommendations, useRecommendations, sourcePickerHash, type Recommendation } from './recommendations';

const icons: Record<string, ReactNode> = {
  'personalize-bud': <MessageEditIcon size="md" />,
  'connect-apps': <PlugIcon size="md" />,
  'create-table': <DatabaseIcon size="md" />,
  'create-workflow': <RepeatIcon size="md" />,
  'add-knowledge': <BookIcon size="md" />,
  'invite-teammate': <UserAddIcon size="md" />,
  meetings: <CalendarSearchIcon size="md" />,
  inbox: <MessageEditIcon size="md" />,
  'table-review': <DatabaseIcon size="md" />,
  github: <TasksIcon size="md" />,
  'slack-update': <MessageEditIcon size="md" />,
  knowledge: <BookIcon size="md" />,
  workflows: <RepeatIcon size="md" />,
  'follow-ups': <TasksIcon size="md" />,
  support: <MessageEditIcon size="md" />,
  week: <CalendarSearchIcon size="md" />,
  standup: <ClockIcon size="md" />,
  process: <NoteIcon size="md" />,
};
const brandNames: Record<Recommendation['brands'][number], string> = {
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  github: 'GitHub',
  slack: 'Slack',
};
const destinations = {
  integrations: '/$workspaceSlug/integrations',
  files: '/$workspaceSlug/files',
  members: '/$workspaceSlug/members',
} as const;
const destinationIcons = {
  integrations: <PlugIcon size="md" />,
  files: <BookIcon size="md" />,
  members: <UserAddIcon size="md" />,
};
const tones: SuggestionTone[] = ['primary', 'info', 'success', 'warning'];
const sourceNames = { google: 'Google', github: 'GitHub', slack: 'Slack' };

export function StartingTasks({ onChoose, disabled }: { onChoose: (prompt: string) => void; disabled: boolean }) {
  const { workspace } = workspaceRoute.useRouteContext();
  const { workspaceSlug } = workspaceRoute.useParams();
  const navigate = useNavigate();
  const { items, message, error, retry, refreshing } = useRecommendations(workspace.id);
  const setup = items.filter(item => item.kind === 'onboarding');
  const suggested = items.filter(item => item.kind === 'prompt');
  const tasks = fillTasks(suggested, fallbackRecommendations);
  const { primary } = prioritizeTasks(tasks);
  const choose = (id: string) => {
    const action = [...tasks, ...setup].find(item => item.id === id)?.action;
    if (action?.kind === 'prompt') onChoose(action.prompt);
    else if (action)
      void navigate({
        to: destinations[action.destination],
        params: { workspaceSlug },
        hash: action.sourcePicker ? sourcePickerHash[action.sourcePicker] : '',
      });
  };
  const rows = (recommendations: Recommendation[]) =>
    recommendations.map(item => {
      const action = item.action;
      const source = action.kind === 'open' ? action.sourcePicker : undefined;
      return {
        id: item.id,
        label: item.label,
        icon:
          action.kind === 'open' ? (
            source ? (
              <BookIcon size="md" />
            ) : (
              destinationIcons[action.destination]
            )
          ) : (
            (icons[item.id] ?? <MessageEditIcon size="md" />)
          ),
        brands: source
          ? [{ brand: source satisfies Brand, name: sourceNames[source] }]
          : item.brands.map(brand => ({ brand: brand satisfies Brand, name: brandNames[brand] })),
      };
    });
  const cards = [
    ...rows(primary.slice(0, 3)).map((row, index) => ({
      ...row,
      kind: index === 0 ? 'Suggested for you' : 'Suggested task',
    })),
    ...rows(setup.slice(0, 1)).map(row => ({ ...row, kind: 'Set up your workspace' })),
  ];
  return (
    <section aria-label="Recommended for you" className="flex w-full flex-col gap-4">
      <SuggestionGrid>
        {cards.map((card, index) => (
          <SuggestionCard
            key={card.id}
            index={index}
            featured={index === 0}
            tone={tones[index % tones.length]!}
            disabled={disabled}
            onClick={() => choose(card.id)}
            icon={card.icon}
            kind={card.kind}
            label={card.label}
            trailing={<BrandStack brands={card.brands} />}
          />
        ))}
      </SuggestionGrid>
      {message &&
        (error ? (
          <div className="flex flex-col gap-2">
            <Alert>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
            <div>
              <Button variant="outline" size="sm" disabled={refreshing} aria-busy={refreshing} onClick={retry}>
                {refreshing ? 'Trying again…' : 'Try again'}
              </Button>
            </div>
          </div>
        ) : (
          <p role="status" className="sr-only">
            {message}
          </p>
        ))}
    </section>
  );
}
