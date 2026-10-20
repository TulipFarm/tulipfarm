import { useEffect, useState } from 'react';
import { Command } from 'reicon-react/icons/Command';
import { ResultCard, ResultAppActions } from '@tulipfarm/sprout/result-card';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { ToolActivity } from '@tulipfarm/sprout/tool-activity';
import { useOptionalCanvas } from './canvas-state';
import { resultActivityApps, type ResultActivity } from './result-activity';
import { toolVisual } from './tool-labels';
import { Disclosure } from '@/components/disclosure';

export function ActivityResultCard({
  id,
  items,
  title = 'Recorded activity',
}: {
  id: string;
  items: ResultActivity[];
  title?: string;
}) {
  const canvas = useOptionalCanvas();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    canvas?.update(id, { title, content: { kind: 'activity-result', items } });
  }, [canvas?.update, id, items, title]);
  if (!items.length) return null;
  const running = items.some(item => item.status === 'running');
  const unknown = items.some(item => item.status === 'unknown');
  const failed = items.some(item => item.status === 'failed' || item.status === 'blocked');
  const completed = items.filter(item => item.status === 'completed').length;
  const status = unknown
    ? 'Some outcomes are unconfirmed'
    : failed
      ? `${completed} of ${items.length} actions completed · Needs attention`
      : running
        ? 'Actions in progress'
        : `${completed} of ${items.length} actions completed`;
  return (
    <div className="space-y-3">
      <ResultCard
        kind="Activity"
        title={title}
        apps={resultActivityApps(items)}
        icon={<Command size={18} />}
        status={status}
        state={unknown || failed ? 'error' : running ? 'running' : 'default'}
        action={{
          label: expanded && !canvas ? 'Hide activity' : 'View activity',
          onClick: () =>
            canvas
              ? canvas.show({ id, title, content: { kind: 'activity-result', items } })
              : setExpanded(value => !value),
        }}
      />
      {!canvas && expanded && <ActivityResultDetails items={items} />}
    </div>
  );
}

export function ActivityResultDetails({ items }: { items: ResultActivity[] }) {
  return (
    <CanvasSection
      title="Recorded activity"
      meta="These are recorded tool outcomes, not independent proof of a file save or delivery. Review the action receipt for that confirmation."
    >
      <ResultAppActions apps={resultActivityApps(items)} />
      <Disclosure title="Activity details">
        <ToolActivity
          items={items.map(item => ({
            ...item,
            label: item.presentation.label,
            visual: toolVisual(item.tool, item.presentation.brand),
          }))}
          variant="stepper"
        />
      </Disclosure>
    </CanvasSection>
  );
}
