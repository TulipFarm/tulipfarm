import type { ReactNode } from 'react';
import { ChevronDown } from 'reicon-react/icons/ChevronDown';
import { Coins } from 'reicon-react/icons/Coins';
import { BrandIcon, type Brand } from '@tulipfarm/sprout/brand-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { InputGroupButton } from '@tulipfarm/sprout/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@tulipfarm/sprout/tooltip';
import type { PlanProvider } from '@/features/models/chatgpt-plan-api';
import type { ComposerModel } from './composer';
import { planUsageStatus } from './plan-usage';
import type { PlanAccountChoice } from './plan-account';

/** Where a model runs: one of the member's own plans, or the workspace's credits. */
export type ModelSource = PlanProvider | 'credits';

const sourceOrder: readonly ModelSource[] = ['chatgpt', 'claude', 'copilot', 'credits'];

const sources: Record<ModelSource, { name: string; hint: string; brand: Brand | null }> = {
  chatgpt: { name: 'ChatGPT plan', hint: 'Counts toward your plan', brand: 'openai' },
  claude: { name: 'Claude plan', hint: 'Counts toward your plan', brand: 'claude' },
  copilot: { name: 'GitHub Copilot plan', hint: 'Counts toward your plan', brand: 'github' },
  credits: { name: 'Workspace credits', hint: 'Uses workspace credits', brand: null },
};

const sourceOf = (model: ComposerModel): ModelSource => model.plan ?? 'credits';

/** What a plan model's replies last said about the plan's usage limit; null for credits. */
const usageOf = (model: ComposerModel) =>
  model.plan && model.planUsage ? planUsageStatus(model.plan, model.planUsage) : null;

/** One model as people see it, with every source that offers it: plans first, then credits. */
export type ModelGroup = { key: string; model: ComposerModel; offers: ComposerModel[] };

// Sources list the same model under different family ids, so the shown name is what makes two entries one model.
const modelKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]/g, '');

export function groupModels(models: readonly ComposerModel[]): ModelGroup[] {
  const groups = new Map<string, ComposerModel[]>();
  for (const model of models) {
    const key = modelKey(model.label);
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  return [...groups].map(([key, offers]) => {
    offers.sort((a, b) => sourceOrder.indexOf(sourceOf(a)) - sourceOrder.indexOf(sourceOf(b)));
    return { key, model: offers.find(offer => !offer.disabled) ?? offers[0]!, offers };
  });
}

const unavailable = (model: ComposerModel) => `Unavailable: ${model.unavailableReason ?? 'not offered here'}`;

/** A short visible reason for a model that can't be picked; the row's full reason is read to screen readers. */
function UnavailableTag({ model }: { model: ComposerModel }) {
  return (
    <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">
      <span aria-hidden="true">{model.unavailableReason === 'temporarily unavailable' ? 'Paused' : 'Turned off'}</span>
      <span className="sr-only">{unavailable(model)}</span>
    </span>
  );
}

function SourceMark({ source }: { source: ModelSource }) {
  const brand = sources[source].brand;
  return brand ? <BrandIcon brand={brand} size="inline" /> : <Coins size={16} aria-hidden="true" />;
}

/** A model's logo; a warning dot marks a plan at its usage limit, though the model stays selectable. */
function ModelMark({ model, warning = false }: { model: ComposerModel; warning?: boolean }) {
  const logo = model.brand ? (
    <BrandIcon brand={model.brand} size="inline" />
  ) : (
    <model.logo size={16} aria-hidden="true" />
  );
  if (!warning) return logo;
  return (
    <span className="relative inline-flex">
      {logo}
      <span
        aria-hidden="true"
        className="absolute -top-1 -right-1 size-2 rounded-full bg-warning ring-2 ring-popover"
      />
    </span>
  );
}

function Row({ mark, label, children }: { mark: ReactNode; label: string; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex shrink-0">{mark}</span>
      <span className="min-w-0 truncate">{label}</span>
      {children}
    </span>
  );
}

type Props = {
  model: ComposerModel | null;
  models: readonly ComposerModel[];
  disabled: boolean;
  onModelChange: (id: string) => void;
  /** The plan account the selected plan model answers with first; listed when the member has several on for chats. */
  account?: PlanAccountChoice | undefined;
};

/**
 * The composer's model menu. Each model is listed once; when more than one source offers it, such as the member's
 * Claude plan, their GitHub Copilot plan and workspace credits, a submenu picks where it runs.
 */
export function ModelPicker({ model, models, disabled, onModelChange, account }: Props) {
  const groups = groupModels(models);
  const planGroups = groups.filter(group => group.offers.some(offer => offer.plan));
  const creditGroups = groups.filter(group => !group.offers.some(offer => offer.plan));
  const off = disabled || models.length === 0;
  const source = model ? sourceOf(model) : null;
  // The trigger names the source when it matters: always for a plan, and for credits when a plan also offers the model.
  const shownSource =
    source &&
    (source !== 'credits' ||
      groups.some(group => group.offers.length > 1 && group.offers.some(offer => offer.id === model!.id)))
      ? sources[source].name
      : null;
  const accounts = model?.plan && account && account.options.length > 1 ? account : null;
  const accountName = accounts?.options.find(option => option.id === accounts.value)?.label;
  const choose = (id: unknown) => onModelChange(String(id));

  // The right edge of every row holds at most one thing: a check, a chevron or "Paused".
  const item = (group: ModelGroup) => {
    // A model no source can run gets no submenu, so its "Paused" lines up with the other unavailable rows.
    if (group.offers.length === 1 || group.offers.every(offer => offer.disabled)) {
      const only = group.offers.length === 1 ? group.offers[0]! : group.model;
      const usage = only.disabled ? null : usageOf(only);
      return (
        <DropdownMenuRadioItem
          key={group.key}
          value={only.id}
          disabled={only.disabled}
          label={only.label}
          aria-label={
            only.plan && !only.disabled
              ? `${only.label}, on ${sources[only.plan].name}${usage ? `, ${usage.status}` : ''}`
              : undefined
          }
          closeOnClick
        >
          <Row mark={<ModelMark model={only} warning={Boolean(usage?.warning)} />} label={only.label}>
            {only.disabled ? (
              <UnavailableTag model={only} />
            ) : (
              usage?.warning && (
                <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground" aria-hidden="true">
                  Limit reached
                </span>
              )
            )}
          </Row>
        </DropdownMenuRadioItem>
      );
    }
    const current = group.offers.find(offer => offer.id === model?.id);
    const warning = Boolean(usageOf(current ?? group.model)?.warning);
    return (
      <DropdownMenuSub key={group.key}>
        <DropdownMenuSubTrigger
          label={group.model.label}
          aria-label={
            current
              ? `${group.model.label}, selected, on ${sources[sourceOf(current)].name}`
              : `${group.model.label}, choose where it runs`
          }
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex shrink-0">
              <ModelMark model={group.model} warning={warning} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{group.model.label}</span>
              {/* The chosen model names where it runs underneath, keeping the right edge for the chevron. */}
              {current && (
                <span className="truncate text-xs text-muted-foreground" aria-hidden="true">
                  {sources[sourceOf(current)].name}
                </span>
              )}
            </span>
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Run {group.model.label} on</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={model?.id ?? ''} onValueChange={choose}>
              {group.offers.map(offer => {
                const source = sourceOf(offer);
                const usage = offer.disabled ? null : usageOf(offer);
                return (
                  <DropdownMenuRadioItem
                    key={offer.id}
                    value={offer.id}
                    disabled={offer.disabled}
                    label={sources[source].name}
                    closeOnClick
                  >
                    <span className="flex min-w-0 flex-1 items-start gap-2 py-0.5">
                      <span className="mt-0.5 flex shrink-0">
                        {usage?.warning ? <ModelMark model={offer} warning /> : <SourceMark source={source} />}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="whitespace-nowrap">{usage?.plan ?? sources[source].name}</span>
                        <span className="text-xs whitespace-nowrap text-muted-foreground">
                          {offer.disabled ? unavailable(offer) : (usage?.status ?? sources[source].hint)}
                        </span>
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };

  const section = (label: string, list: ModelGroup[]) =>
    list.length > 0 && (
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={model?.id ?? ''} onValueChange={choose}>
          {list.map(item)}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    );

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <InputGroupButton
                  size="md"
                  variant="ghost"
                  disabled={off}
                  aria-label={`Model: ${model?.label ?? 'None'}${source ? `, on ${sources[source].name}` : ''}${accountName ? `, account ${accountName}` : ''}`}
                />
              }
            />
          }
        >
          {/* Phones drop the logo and shorten the name so the trigger clears the composer's other controls. */}
          {model && (
            <span className="hidden sm:flex">
              <ModelMark model={model} />
            </span>
          )}
          <span className="max-w-20 truncate sm:max-w-40">{model?.label ?? 'Model'}</span>
          {(accountName ?? shownSource) && (
            <span className="hidden max-w-40 truncate text-xs text-muted-foreground sm:inline">{`· ${accountName ?? shownSource}`}</span>
          )}
          <ChevronDown size={14} aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>AI model that writes replies, and where it runs</TooltipContent>
      </Tooltip>
      <DropdownMenuContent size="menu" side="top" align="end">
        {section('Your plans', planGroups)}
        {planGroups.length > 0 && creditGroups.length > 0 && <DropdownMenuSeparator />}
        {section(planGroups.length > 0 ? 'Workspace credits' : 'Model', creditGroups)}
        {accounts && model?.plan && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{`${sources[model.plan].name.replace(/ plan$/, '')} account`}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={accounts.value ?? ''}
                onValueChange={value => {
                  if (typeof value === 'string' && value) accounts.onChange(value);
                }}
              >
                {accounts.options.map(option => (
                  <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
                    <span className="truncate">{option.label}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
