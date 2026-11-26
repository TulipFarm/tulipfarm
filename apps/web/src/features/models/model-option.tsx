import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import { ModelLogo } from './model-logo';
import { familyPlan, type PlanProvider } from './chatgpt-plan-api';

const credits = (value: number | null | undefined) => (value == null ? 'Not priced' : value.toLocaleString());

const planNames: Record<PlanProvider, string> = {
  chatgpt: 'ChatGPT plan',
  claude: 'Claude plan',
  copilot: 'GitHub Copilot plan',
  'byok-anthropic': 'Anthropic API key',
  'byok-openai': 'OpenAI API key',
  'byok-google': 'Google AI Studio API key',
  'byok-xai': 'xAI API key',
  'byok-openai-compatible': 'Custom API key',
};

export function ModelOption({ family, details = false }: { family: ModelCatalogFamily; details?: boolean }) {
  const plan = familyPlan(family);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ModelLogo vendor={family.vendor} />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate">
          {family.displayName}
          {!family.available &&
            (family.unavailableReason === 'model-family-paused' ? ' (temporarily unavailable)' : ' (unavailable)')}
        </span>
        {details && (
          <span className="text-xs font-normal text-muted-foreground">
            {plan ? (
              `${planNames[plan]}, no workspace credits`
            ) : family.inputCreditsPerMillionTokens == null && family.outputCreditsPerMillionTokens == null ? (
              'Not priced'
            ) : (
              <>
                {credits(family.inputCreditsPerMillionTokens)} input / {credits(family.outputCreditsPerMillionTokens)}{' '}
                output Credits per 1M tokens
              </>
            )}
          </span>
        )}
      </span>
    </span>
  );
}
