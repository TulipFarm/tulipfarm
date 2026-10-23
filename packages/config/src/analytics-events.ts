// Every product analytics event the server sends, in one typed registry, like feature-flags.ts.
// trackEvent in @tulipfarm/observability sends only declared properties of the declared type, so
// names, emails, prompts, message text and other free text never reach an analytics provider.
// Events go to the registered analytics extension; with none, nothing is sent.
//
// Add an event here, then call trackEvent where the action has committed. Name events
// `<object>_<past-tense verb>` in snake_case. Prefer IDs and enumerated values.

export type AnalyticsPropertyType =
  | 'boolean'
  | 'number'
  | 'id'
  | { readonly enum: readonly string[] }
  | { readonly identifier: true };

export type AnalyticsEventDefinition = {
  readonly description: string;
  readonly properties: Readonly<Record<string, AnalyticsPropertyType>>;
};

/** A short lowercase identifier such as a provider name; anything else is dropped. */
const identifier = { identifier: true } as const;

export const analyticsEvents = {
  user_signed_up: { description: 'A user account was created.', properties: {} },
  workspace_created: { description: 'A workspace finished setup and is ready.', properties: {} },
  member_invited: {
    description: 'An email invitation to a workspace was issued.',
    properties: { resend: 'boolean' },
  },
  member_joined: { description: 'A user accepted an invitation and joined a workspace.', properties: {} },
  conversation_started: { description: 'A user started a new conversation.', properties: { in_project: 'boolean' } },
  message_sent: { description: 'A user sent a message in a conversation.', properties: {} },
  agent_save_requested: {
    description: 'A user submitted a new agent or an agent edit. The worker applies it afterwards.',
    properties: { agent_id: 'id', created: 'boolean' },
  },
  workflow_saved: {
    description: 'A user saved a new workflow or a workflow revision.',
    properties: { workflow_id: 'id', created: 'boolean' },
  },
  integration_connected: {
    description: 'A member or agent connected an integration to a workspace.',
    properties: { provider: identifier },
  },
  integration_disconnected: {
    description: 'A member or agent removed an integration from a workspace.',
    properties: { provider: identifier },
  },
  task_completed: {
    description: 'A task reached a terminal status. A retried task can complete again.',
    properties: { outcome: { enum: ['completed', 'failed'] } },
  },
} as const satisfies Record<string, AnalyticsEventDefinition>;

export type AnalyticsEventName = keyof typeof analyticsEvents;

type PropertyValue<T> = T extends 'boolean'
  ? boolean
  : T extends 'number'
    ? number
    : T extends { readonly enum: readonly (infer V)[] }
      ? V
      : string;

export type AnalyticsEventProperties<E extends AnalyticsEventName> = {
  readonly [K in keyof (typeof analyticsEvents)[E]['properties']]?: PropertyValue<
    (typeof analyticsEvents)[E]['properties'][K]
  >;
};

export const analyticsEventNames = Object.keys(analyticsEvents) as AnalyticsEventName[];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortIdentifier = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function valid(type: AnalyticsPropertyType, value: unknown) {
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'id') return typeof value === 'string' && uuid.test(value);
  if ('enum' in type) return typeof value === 'string' && type.enum.includes(value);
  return typeof value === 'string' && shortIdentifier.test(value);
}

/** The declared properties of an event whose values have the declared type; everything else is dropped. */
export function analyticsEventProperties(event: string, properties: Readonly<Record<string, unknown>>) {
  if (!Object.hasOwn(analyticsEvents, event)) return {};
  const declared: Readonly<Record<string, AnalyticsPropertyType>> =
    analyticsEvents[event as AnalyticsEventName].properties;
  return Object.fromEntries(
    Object.entries(properties).filter(([key, value]) => Object.hasOwn(declared, key) && valid(declared[key]!, value)),
  ) as Record<string, string | number | boolean>;
}

export function isAnalyticsEvent(event: string): event is AnalyticsEventName {
  return Object.hasOwn(analyticsEvents, event);
}
