import type { ExecutionReceipt } from '@tulipfarm/conversations/tool-activity';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';

const languageNames: Record<ExecutionReceipt['language'], string> = {
  python: 'Python',
  javascript: 'JavaScript',
  bash: 'Bash',
};
const block = 'max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs';

export function ExecutionDetails({ execution, narration }: { execution: ExecutionReceipt; narration: string | null }) {
  const result = execution.result;
  return (
    <div className="space-y-1">
      {narration ? <p className="text-sm text-muted-foreground">{narration}</p> : null}
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="link" size="sm" />}>Show code</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 py-1">
            <section aria-label={`${languageNames[execution.language]} code`}>
              <p className="text-xs text-muted-foreground">{languageNames[execution.language]}</p>
              <pre className={block}>{execution.code}</pre>
            </section>
            {result ? (
              <section aria-label="Output">
                <p className="text-xs text-muted-foreground">
                  Output{result.exitCode === undefined ? '' : ` · exit ${result.exitCode}`}
                  {result.state === 'completed' ? '' : ` · ${result.state}`}
                </p>
                {result.stdout ? <pre className={block}>{result.stdout}</pre> : null}
                {result.stderr ? <pre className={`${block} text-destructive`}>{result.stderr}</pre> : null}
                {!result.stdout && !result.stderr ? <p className="text-xs text-muted-foreground">No output.</p> : null}
                {result.truncated ? <p className="text-xs text-muted-foreground">Output was cut short.</p> : null}
              </section>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
