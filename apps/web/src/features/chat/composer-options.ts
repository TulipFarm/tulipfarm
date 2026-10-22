import type { ComponentType } from 'react';
import { Calculator } from 'reicon-react/icons/Calculator';
import { GraduationCap } from 'reicon-react/icons/GraduationCap';
import { Headset } from 'reicon-react/icons/Headset';
import { Lightbulb } from 'reicon-react/icons/Lightbulb';
import { Map } from 'reicon-react/icons/Map';
import { Telescope } from 'reicon-react/icons/Telescope';
import { Truck } from 'reicon-react/icons/Truck';
import { User } from 'reicon-react/icons/User';
import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import { catalogFamily, catalogFixture, externalCatalogFamilyIds } from '@/features/models/catalog-fixture';
import { modelBrand, type ModelBrand } from '@/features/models/model-brand';
import { familyCost } from '@/features/models/family-cost';
import { modelLogo } from '@/features/models/model-logo';

export type Icon = ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>;

export type Mode = {
  id: 'plan' | 'shared-brainstorm' | 'learn' | 'research';
  label: string;
  description: string;
  icon: Icon;
  tone: 'text-info' | 'text-warning' | 'text-success' | 'text-chart-4';
};
export type Agent = { id: string; label: string; description: string; icon: Icon };
/** `cost` is a raw number where higher costs more; the model picker rates it against the other models. */
export type Model = { id: string; label: string; logo: Icon; brand: ModelBrand | null; cost?: number | undefined };

export type Persona = { kind: 'mode'; mode: Mode } | { kind: 'agent'; agent: Agent };

export const modes: readonly Mode[] = [
  {
    id: 'plan',
    label: 'Plan',
    description: 'Agree on the steps before anything changes',
    icon: Map,
    tone: 'text-info',
  },
  {
    id: 'shared-brainstorm',
    label: 'Shared brainstorm',
    description: 'Explore ideas together with your team',
    icon: Lightbulb,
    tone: 'text-warning',
  },
  {
    id: 'learn',
    label: 'Learn',
    description: 'Teach TulipFarm how your business works',
    icon: GraduationCap,
    tone: 'text-success',
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Gather and cite sources before answering',
    icon: Telescope,
    tone: 'text-chart-4',
  },
];

export const agents: readonly Agent[] = [
  { id: 'operations', label: 'Operations', description: 'Runs day-to-day workflows', icon: User },
  { id: 'bookkeeper', label: 'Bookkeeper', description: 'Reconciles invoices and payments', icon: Calculator },
  { id: 'support', label: 'Support', description: 'Drafts replies to customer requests', icon: Headset },
  { id: 'fulfillment', label: 'Fulfillment', description: 'Tracks orders and shipments', icon: Truck },
];

const model = (family: ModelCatalogFamily): Model => ({
  id: family.id,
  label: family.displayName,
  logo: modelLogo(family.vendor),
  brand: modelBrand(family.vendor),
  cost: familyCost(family),
});

export const defaultModel = model(catalogFamily('claude-opus'));

export const models: readonly Model[] = [
  defaultModel,
  ...catalogFixture([
    'claude-sonnet',
    'gpt-sol',
    'deepseek-pro',
    'grok',
    'kimi',
    ...externalCatalogFamilyIds,
  ]).families.map(model),
];
