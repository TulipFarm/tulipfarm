import { createContext, use, type ReactNode } from 'react';
import { z } from 'zod';
import {
  A2uiSurface,
  defineCatalog,
  defineComponent,
  sproutAdapters,
  sproutCatalog,
  type A2uiAdapterProps,
  type A2uiComponent,
} from '@tulipfarm/sprout/a2ui';
import { Button } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';
import { resourceTypes } from './progress';

type PackageAction = {
  label: string;
  run: () => void;
  disabled?: boolean;
  secondary?: boolean;
};

type PackageControls = {
  actions: Record<string, PackageAction>;
  question?: ReactNode;
  plan?: ReactNode;
  definitions?: ReactNode;
  feedback?: ReactNode;
};

const Controls = createContext<PackageControls>({ actions: {} });
const catalog = defineCatalog({
  id: 'tulipfarm/package-install@1',
  extends: sproutCatalog,
  components: {
    PackageResource: defineComponent({
      description: 'A package resource or count with its standard resource-type icon.',
      props: z.strictObject({
        kind: z.enum(['table', 'seed-row', 'skill', 'agent', 'workflow', 'integration', 'file']),
        text: z.string(),
        badge: z.boolean().optional(),
      }),
    }),
    PackageAction: defineComponent({
      description: 'An installer action bound to the current viewer and checked package state.',
      props: z.strictObject({ action: z.string() }),
    }),
    PackageQuestion: defineComponent({
      description: 'The one current package input, using permitted workspace choices.',
      props: z.strictObject({}),
    }),
    PackagePlan: defineComponent({
      description: 'Open the exact package plan or saved installation in the native canvas.',
      props: z.strictObject({}),
    }),
    PackageDefinitions: defineComponent({
      description: 'Complete approval definitions and files from the authorized installation.',
      props: z.strictObject({}),
    }),
    PackageWriteStatus: defineComponent({
      description: 'The current installer write receipt, with safe retry and recovery controls.',
      props: z.strictObject({}),
    }),
  },
});

function ActionAdapter({ props }: A2uiAdapterProps<{ action: string }>) {
  const action = use(Controls).actions[props.action];
  if (!action) return null;
  return (
    <Button variant={action.secondary ? 'outline' : 'default'} disabled={action.disabled} onClick={action.run}>
      {action.label}
    </Button>
  );
}

function ResourceAdapter({
  props,
}: A2uiAdapterProps<{ kind: keyof typeof resourceTypes; text: string; badge?: boolean }>) {
  const type = resourceTypes[props.kind];
  if (props.badge)
    return (
      <span className="sprout-a2ui-badge">
        <Badge variant="secondary">
          {type.icon}
          {props.text}
        </Badge>
      </span>
    );
  return (
    <div className="flex items-start gap-2">
      <span role="img" aria-label={type.label} className="inline-flex h-5 shrink-0 items-center [&>svg]:size-4">
        {type.icon}
      </span>
      <span>{props.text}</span>
    </div>
  );
}

const adapters = {
  ...sproutAdapters,
  PackageResource: ResourceAdapter,
  PackageAction: ActionAdapter,
  PackageQuestion: () => use(Controls).question,
  PackagePlan: () => use(Controls).plan,
  PackageDefinitions: () => use(Controls).definitions,
  PackageWriteStatus: () => use(Controls).feedback,
};

export function PackageSuccess({ id, title, details }: { id: string; title: string; details: ReactNode }) {
  return (
    <div aria-live="polite">
      <PackageSurface
        id={id}
        actions={{}}
        components={[
          { id: 'root', component: 'Column', children: ['heading', 'success', 'details'] },
          { id: 'heading', component: 'Heading', level: 1, text: `${title} installed` },
          {
            id: 'success',
            component: 'Callout',
            tone: 'success',
            title: 'Installation complete',
            text: 'Setup is complete. No further approval is needed.',
          },
          {
            id: 'details',
            component: 'Details',
            items: [{ title: 'Installation details', child: 'plan' }],
          },
          { id: 'plan', component: 'PackagePlan' },
        ]}
        plan={details}
      />
    </div>
  );
}

export function PackageSurface({
  id,
  components,
  actions,
  question,
  plan,
  definitions,
  feedback,
}: PackageControls & { id: string; components: A2uiComponent[] }) {
  return (
    <Controls value={{ actions, question, plan, definitions, feedback }}>
      <div className="max-w-2xl" data-package-surface={id}>
        <A2uiSurface
          catalog={catalog}
          adapters={adapters}
          size="compact"
          messages={[
            { version: 'v0.9.1', createSurface: { surfaceId: id, catalogId: catalog.id } },
            { version: 'v0.9.1', updateComponents: { surfaceId: id, components } },
          ]}
        />
      </div>
    </Controls>
  );
}
