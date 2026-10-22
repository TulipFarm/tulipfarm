import { Button } from '@tulipfarm/sprout/button';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';

/** Operator guide for configuring model providers and the catalog. */
export const modelSetupDocsUrl = new URL(
  '/self-hosting/models/',
  import.meta.env.VITE_DOCS_URL || 'https://docs.tulipfarm.ai',
).href;

export const noModelsConfigured = 'No models configured';

export function ModelSetupLink({ size = 'xs' }: { size?: 'xs' | 'sm' }) {
  return (
    <Button
      size={size}
      variant="outline"
      nativeButton={false}
      render={<a href={modelSetupDocsUrl} target="_blank" rel="noopener noreferrer" />}
    >
      Model setup guide
      <ArrowUpRight size={14} aria-hidden="true" />
    </Button>
  );
}
