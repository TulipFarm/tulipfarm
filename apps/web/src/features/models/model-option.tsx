import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import { ModelLogo } from './model-logo';

const credits = (value: number | null | undefined) => (value == null ? 'Not priced' : value.toLocaleString());

export function ModelOption({ family, details = false }: { family: ModelCatalogFamily; details?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ModelLogo vendor={family.vendor} />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate">
          {family.displayName}
          {!family.available && ' (unavailable)'}
        </span>
        {details && (
          <span className="text-xs font-normal text-muted-foreground">
            {family.inputCreditsPerMillionTokens == null && family.outputCreditsPerMillionTokens == null ? (
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
