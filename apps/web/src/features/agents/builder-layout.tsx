import { useSyncExternalStore, type ReactNode } from 'react';
import { Check, CircleAlert, Eye } from 'lucide-react';
import { Button } from '@tulipfarm/sprout/button';
import { Form } from '@tulipfarm/sprout/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@tulipfarm/sprout/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tulipfarm/sprout/tabs';

export const builderSteps = [
  { id: 'basics', label: 'Basics' },
  { id: 'skills', label: 'Skills' },
  { id: 'access', label: 'Access' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'review', label: 'Review' },
] as const;
export type BuilderStep = (typeof builderSteps)[number]['id'];

const wideQuery = '(min-width: 1280px)';
const subscribeWidth = (changed: () => void) => {
  const media = window.matchMedia(wideQuery);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
};

export function AgentBuilderLayout({
  step,
  onStep,
  completed,
  errors,
  panels,
  footer,
  preview,
  previewOpen,
  onPreviewOpenChange,
  disabled,
  onSubmit,
}: {
  step: BuilderStep;
  onStep: (step: BuilderStep) => void;
  completed: ReadonlySet<BuilderStep>;
  errors: ReadonlySet<BuilderStep>;
  panels: Record<BuilderStep, ReactNode>;
  footer: ReactNode;
  preview: ReactNode;
  previewOpen: boolean;
  onPreviewOpenChange: (open: boolean) => void;
  disabled: boolean;
  onSubmit: () => 'invalid' | void;
}) {
  const wide = useSyncExternalStore(
    subscribeWidth,
    () => window.matchMedia(wideQuery).matches,
    () => false,
  );
  const choose = (value: unknown) => {
    const next = builderSteps.find(item => item.id === value);
    if (next) onStep(next.id);
  };
  return (
    <div className="grid min-w-0 items-start gap-6 xl:flex">
      <div className="min-w-0 xl:flex-3">
        <Tabs value={step} onValueChange={choose}>
          <div className="hidden min-w-0 pb-3 sm:block">
            <TabsList variant="steps" aria-label="Agent setup sections">
              {builderSteps.map((item, index) => (
                <TabsTrigger key={item.id} value={item.id}>
                  <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center text-xs">
                    {errors.has(item.id) ? (
                      <CircleAlert className="size-4 text-destructive" />
                    ) : completed.has(item.id) ? (
                      <Check className="size-4" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  {item.label}
                  {errors.has(item.id) && <span className="sr-only">, needs attention</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div className="flex min-w-0 items-center gap-2 pb-3 sm:hidden">
            <div className="min-w-0 flex-1">
              <Select value={step} onValueChange={choose}>
                <SelectTrigger width="full" aria-label="Setup section">
                  <SelectValue>{builderSteps.find(item => item.id === step)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {builderSteps.map((item, index) => (
                    <SelectItem key={item.id} value={item.id}>
                      {index + 1}. {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {!wide && (
            <Sheet open={previewOpen} onOpenChange={onPreviewOpenChange}>
              <div className="mb-3">
                <SheetTrigger render={<Button variant="outline" />}>
                  <Eye aria-hidden="true" />
                  View agent
                </SheetTrigger>
              </div>
              <SheetContent size="lg">
                <SheetHeader>
                  <SheetTitle>Agent view</SheetTitle>
                  <SheetDescription>Changes follow your draft. Test chat cannot take actions.</SheetDescription>
                </SheetHeader>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">{preview}</div>
              </SheetContent>
            </Sheet>
          )}
          <Form disabled={disabled} onSubmit={onSubmit} label="Agent setup">
            <div className="grid min-w-0 gap-5">
              {builderSteps.map(item => (
                <TabsContent key={item.id} value={item.id} keepMounted>
                  <div className="grid min-w-0 gap-4">{panels[item.id]}</div>
                </TabsContent>
              ))}
              {footer}
            </div>
          </Form>
        </Tabs>
      </div>
      {wide && (
        <aside aria-label="Agent view" className="sticky top-4 min-w-0 xl:flex-2">
          {preview}
        </aside>
      )}
    </div>
  );
}
