import type { ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { Button } from '@tulipfarm/sprout/button';

export function Disclosure({
  title,
  defaultOpen = false,
  hidden = false,
  children,
  open,
  onOpenChange,
}: {
  title: string;
  defaultOpen?: boolean;
  hidden?: boolean;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <section hidden={hidden}>
      <Collapsible defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger render={<Button variant="outline" />}>{title}</CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <div className="space-y-4 pt-4">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
