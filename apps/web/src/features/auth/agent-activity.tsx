import { useEffect, useState } from 'react';
import { CheckCircleIcon } from '@tulipfarm/icons';
import { AgentMark } from '@/components/agent-mark';
import {
  GradientBanner,
  GradientBannerBadge,
  GradientBannerPanel,
  GradientBannerProgress,
} from '@tulipfarm/sprout/gradient-banner';
import { Spinner } from '@tulipfarm/sprout/spinner';

const agents = [
  {
    id: 'agent-marketing',
    name: 'Marketing agent',
    task: 'Spring launch email',
    steps: [
      'Reading last campaign results',
      'Writing three subject lines',
      'Checking brand voice',
      'Proposing a Tuesday morning send',
    ],
    result: 'Email ready for your approval',
  },
  {
    id: 'leads_agent',
    name: 'Leads agent',
    task: 'Qualify new leads',
    steps: [
      'Enriching company data',
      'Scoring against ideal customer profile',
      'Drafting follow-ups for the best fits',
      'Proposing lead row updates',
    ],
    result: 'Lead shortlist ready for review',
  },
  {
    id: 'agent_engineering',
    name: 'Engineering agent',
    task: 'Fix checkout timeout',
    steps: [
      'Reproducing the timeout',
      'Tracing a slow database query',
      'Drafting a missing index',
      'Preparing the change for review',
    ],
    result: 'Fix ready for review',
  },
];

const ticksPerStep = 4;
const holdTicks = 6;

function useTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => setTick(value => value + 1), 700);
    return () => window.clearInterval(id);
  }, []);
  return tick;
}

export function AgentActivity() {
  const tick = useTick();
  const work = ticksPerStep * 4;
  const run = work + holdTicks;
  const active = Math.floor(tick / run) % agents.length;
  const agent = agents[active]!;
  const elapsed = tick % run;
  const done = elapsed >= work;
  const current = Math.min(Math.floor(elapsed / ticksPerStep), agent.steps.length);

  return (
    <GradientBanner variant="iris" size="lg">
      <div className="grid w-full max-w-md gap-6">
        <div className="flex justify-center">
          <GradientBannerPanel tone="dark">
            <GradientBannerBadge>Example</GradientBannerBadge>
            <span>How agents work in TulipFarm</span>
          </GradientBannerPanel>
        </div>
        <div key={agent.id} className="animate-in duration-700 fade-in zoom-in-95 slide-in-from-bottom-6">
          <GradientBannerPanel>
            <div className="grid w-full gap-4 py-1">
              <div className="flex items-center gap-3">
                <AgentMark agentId={agent.id} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{agent.name}</p>
                  <p className="truncate text-sm opacity-70">{agent.task}</p>
                </div>
                <GradientBannerBadge>{done ? 'Done' : 'Working'}</GradientBannerBadge>
              </div>
              <GradientBannerProgress value={Math.min((elapsed / work) * 100, 100)} />
              <ol className="grid gap-2 text-sm">
                {agent.steps.map((step, index) => (
                  <li
                    key={step}
                    className={
                      index <= current
                        ? 'flex items-center gap-2 transition duration-500'
                        : 'flex -translate-x-2 items-center gap-2 opacity-0 transition duration-500'
                    }
                  >
                    {index < current ? <CheckCircleIcon size="md" /> : <Spinner />}
                    <span className="truncate">{step}</span>
                  </li>
                ))}
              </ol>
              <div className={done ? 'transition duration-500' : 'scale-95 opacity-0 transition duration-500'}>
                <GradientBannerBadge>
                  <CheckCircleIcon size="sm" />
                  {agent.result}
                </GradientBannerBadge>
              </div>
            </div>
          </GradientBannerPanel>
        </div>
        <div className="flex justify-center gap-2">
          {agents.map((item, index) => (
            <span
              key={item.id}
              className={
                index === active ? 'transition-opacity duration-500' : 'opacity-40 transition-opacity duration-500'
              }
            >
              <AgentMark agentId={item.id} size={24} />
            </span>
          ))}
        </div>
      </div>
    </GradientBanner>
  );
}
