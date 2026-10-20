import { useCallback, useEffect, useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { canvasScenarios, completeCanvasMock } from './canvas-mock-api';

export default function CanvasMockControls() {
  const [scenario, setScenario] = useState(
    () => new URLSearchParams(window.location.search).get('scenario') ?? 'running',
  );
  const complete = useCallback(() => {
    if (scenario.startsWith('plan-')) return;
    completeCanvasMock();
    if (!['web', 'history'].includes(scenario) && !scenario.startsWith('timeline') && !scenario.startsWith('knowledge'))
      setScenario('completed');
  }, [scenario]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        complete();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [complete]);
  return (
    <div className="flex flex-wrap items-center gap-3 border-b bg-muted px-4 py-2 text-xs">
      <span>Local mock. No real changes.</span>
      <Select
        value={scenario}
        items={canvasScenarios}
        onValueChange={value => {
          if (value) window.location.assign(`${window.location.pathname}?scenario=${value}`);
        }}
      >
        <SelectTrigger size="sm" aria-label="Mock scenario">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(canvasScenarios).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!scenario.startsWith('plan-') && (
        <Button
          variant="outline"
          size="sm"
          title="Ctrl+Shift+Enter completes the mock without moving focus"
          onClick={complete}
        >
          Complete read
        </Button>
      )}
    </div>
  );
}
