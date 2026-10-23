import type { ModelCatalogFamily, ModelCatalogImageModel } from '@tulipfarm/config/model-catalog';
import { Disclosure } from '@/components/disclosure';
import { useFlag } from '@/lib/feature-flags';

export function FamilyDetails({
  family,
  imageModels = [],
  expanded = false,
}: {
  family: ModelCatalogFamily;
  imageModels?: ModelCatalogImageModel[];
  expanded?: boolean;
}) {
  const images = useFlag('images');
  const paired = imageModels.find(image => image.id === family.imageModelId);
  const rates = (
    <>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Current mapped version</dt>
          <dd className="break-words">{family.currentVersion ?? 'No mapped version'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Provider</dt>
          <dd>{family.provider}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Input credits per million tokens</dt>
          <dd>{family.inputCreditsPerMillionTokens?.toLocaleString() ?? 'Not priced'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Output credits per million tokens</dt>
          <dd>{family.outputCreditsPerMillionTokens?.toLocaleString() ?? 'Not priced'}</dd>
        </div>
        {images && (
          <>
            <div>
              <dt className="text-muted-foreground">Reads images</dt>
              <dd>{family.imageInput ? 'Yes' : 'No, the workspace image reader describes them'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Creates images with</dt>
              <dd>
                {family.imageModelId
                  ? `${paired?.displayName ?? family.imageModelId}${paired && !paired.available ? ' (unavailable)' : ''}`
                  : 'The workspace default image model'}
              </dd>
            </div>
          </>
        )}
      </dl>
      <p className="text-sm text-muted-foreground">
        Credits depend on input and generated output. These are base-context rates; longer contexts may have different
        rates.
      </p>
    </>
  );
  return (
    <div className="space-y-2 text-base">
      <p>
        {family.available
          ? 'Available for permitted workspace use.'
          : family.unavailableReason === 'workspace-disabled'
            ? 'Disabled in this workspace.'
            : family.unavailableReason === 'model-family-paused'
              ? 'Temporarily unavailable for new chats and agents.'
              : 'Temporarily unavailable from the platform.'}
      </p>
      {expanded ? rates : <Disclosure title="Rates and model version">{rates}</Disclosure>}
      {!family.available && (
        <p className="text-muted-foreground">
          {family.unavailableReason === 'workspace-disabled'
            ? 'An admin can enable it in model access. Saved preferences are retained.'
            : family.unavailableReason === 'model-family-paused'
              ? "Existing agents and chats keep it, or use its fallback rule's model when one is set. Choose another model for new work."
              : 'Choose an available model or check again later. Saved preferences are retained.'}
        </p>
      )}
    </div>
  );
}
