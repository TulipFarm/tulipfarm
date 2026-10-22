import type { ReactNode } from 'react';

/** The destination and audience shown before a file's text is added anywhere. */
export function PromotionSummary({ destination, audience }: { destination: ReactNode; audience: ReactNode }) {
  return (
    <dl className="space-y-2 rounded-lg border px-3 py-3 text-sm">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        <dt className="w-32 shrink-0 text-muted-foreground">Destination</dt>
        <dd className="flex min-w-0 flex-1 basis-48 items-center gap-1.5 font-medium text-foreground">{destination}</dd>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        <dt className="w-32 shrink-0 text-muted-foreground">Who can use it</dt>
        <dd className="min-w-0 flex-1 basis-48 text-foreground">{audience}</dd>
      </div>
    </dl>
  );
}
