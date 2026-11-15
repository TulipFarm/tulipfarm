import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Book } from 'reicon-react/icons/Book';
import { CalendarSearch } from 'reicon-react/icons/CalendarSearch';
import { Checklist } from 'reicon-react/icons/Checklist';
import { Clock } from 'reicon-react/icons/Clock';
import { Database } from 'reicon-react/icons/Database';
import { MessageEdit } from 'reicon-react/icons/MessageEdit';
import { Note } from 'reicon-react/icons/Note';
import { Plug } from 'reicon-react/icons/Plug';
import { Repeat } from 'reicon-react/icons/Repeat';
import { UserAdd } from 'reicon-react/icons/UserAdd';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { BrandStack, type Brand } from '@tulipfarm/sprout/brand-icon';
import { SuggestionCard, SuggestionGrid, type SuggestionTone } from '@/components/chat-suggestions';
import { workspaceRoute } from '@/router';
import { fillTasks, prioritizeTasks } from './starting-task-priority';
import { fallbackRecommendations, useRecommendations, sourcePickerHash, type Recommendation } from './recommendations';

const icons: Record<string, ReactNode> = {
  'personalize-bud': <MessageEdit size={16} />,
  'connect-apps': <Plug size={16} />,
  'create-table': <Database size={16} />,
  'create-workflow': <Repeat size={16} />,
  'add-knowledge': <Book size={16} />,
  'invite-teammate': <UserAdd size={16} />,
  meetings: <CalendarSearch size={16} />,
  inbox: <MessageEdit size={16} />,
  'table-review': <Database size={16} />,
  github: <Checklist size={16} />,
  'slack-update': <MessageEdit size={16} />,
  knowledge: <Book size={16} />,
  workflows: <Repeat size={16} />,
  'follow-ups': <Checklist size={16} />,
  support: <MessageEdit size={16} />,
  week: <CalendarSearch size={16} />,
  standup: <Clock size={16} />,
  process: <Note size={16} />,
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
  integrations: <Plug size={16} />,
  files: <Book size={16} />,
  members: <UserAdd size={16} />,
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
              <Book size={16} />
            ) : (
              destinationIcons[action.destination]
            )
          ) : (
            (icons[item.id] ?? <MessageEdit size={16} />)
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
